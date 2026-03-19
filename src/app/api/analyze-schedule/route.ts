import { NextResponse } from 'next/server';

type AnalyzeTask = {
  id: string;
  task_code: string;
  task_name: string;
  start: string;
  end: string;
  progress: number;
  isCritical?: boolean;
  resources?: string;
  wbs_id?: string;
};

type AnalyzeRequest = {
  tasks?: AnalyzeTask[];
};

function buildPrompt(tasks: AnalyzeTask[]): string {
  const sorted = [...tasks].sort((a, b) => a.start.localeCompare(b.start));
  const total = sorted.length;
  const critical = sorted.filter((t) => t.isCritical).length;
  const done = sorted.filter((t) => t.progress >= 100).length;
  const delayedLike = sorted.filter((t) => t.progress < 100 && t.isCritical).length;
  const preview = sorted.slice(0, 250).map((t) => ({
    code: t.task_code,
    name: t.task_name,
    start: t.start,
    end: t.end,
    progress: t.progress,
    critical: !!t.isCritical,
    resources: t.resources ?? '',
    wbs_id: t.wbs_id ?? '',
  }));

  return [
    'Ты планировщик проектов Primavera P6.',
    'Сделай практический анализ календарного графика и предложи улучшения.',
    'Формат ответа:',
    '1) Короткий вывод (2-4 пункта).',
    '2) Риски по критическому пути (до 5 пунктов).',
    '3) Конкретные предложения по улучшению (до 10 пунктов) с приоритетом High/Medium/Low.',
    '4) Быстрые действия на 7 дней (чеклист).',
    '',
    `Статистика: tasks=${total}, critical=${critical}, completed=${done}, critical_incomplete=${delayedLike}.`,
    'Данные задач (усеченная выборка):',
    JSON.stringify(preview),
  ].join('\n');
}

export async function POST(req: Request) {
  try {
    // Вместо req.json() используем req.text() + JSON.parse.
    // На prod Vercel у нас сейчас req.json() возвращает 502 с сообщением про JSON,
    // хотя клиент отправляет корректное application/json.
    const raw = await req.text();
    let body: AnalyzeRequest = {};
    try {
      body = raw ? (JSON.parse(raw) as AnalyzeRequest) : {};
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      );
    }
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    if (tasks.length === 0) {
      return NextResponse.json({ error: 'Нет данных задач для анализа.' }, { status: 400 });
    }

    const tasksToSend = tasks.slice(0, 200);

    // Если настроен n8n, проксируем запрос туда (и возвращаем результат обратно в сайт).
    // В Vercel можно задать либо серверную `N8N_ANALYZE_WEBHOOK_URL`, либо (для простоты) `NEXT_PUBLIC_N8N_ANALYZE_WEBHOOK_URL`.
    const n8nUrl =
      (process.env.N8N_ANALYZE_WEBHOOK_URL && process.env.N8N_ANALYZE_WEBHOOK_URL.trim() !== ''
        ? process.env.N8N_ANALYZE_WEBHOOK_URL
        : undefined) ||
      (process.env.NEXT_PUBLIC_N8N_ANALYZE_WEBHOOK_URL &&
      process.env.NEXT_PUBLIC_N8N_ANALYZE_WEBHOOK_URL.trim() !== ''
        ? process.env.NEXT_PUBLIC_N8N_ANALYZE_WEBHOOK_URL
        : undefined);
    if (n8nUrl && typeof n8nUrl === 'string' && n8nUrl.trim() !== '') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      let n8nFailure: string | undefined;
      try {
        const resp = await fetch(n8nUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: tasksToSend }),
          signal: controller.signal,
        });

        const text = await resp.text();
        let data: { analysis?: string; error?: string };
        try {
          data = text ? (JSON.parse(text) as { analysis?: string; error?: string }) : {};
        } catch {
          n8nFailure = `n8n returned non-JSON (HTTP ${resp.status}). Preview: ${text.slice(0, 200)}`;
          // fallback to DeepSeek below
          data = {};
        }

        if (resp.ok) {
          const analysis = data.analysis;
          if (analysis) return NextResponse.json({ analysis });
          n8nFailure = data.error || 'n8n returned empty analysis.';
        } else {
          n8nFailure = data.error || `n8n error (HTTP ${resp.status}).`;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message.toLowerCase().includes('aborted')) {
          n8nFailure = 'n8n timeout (45s).';
        } else {
          n8nFailure = `n8n request failed: ${message}`;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Не задан DEEPSEEK_API_KEY в переменных окружения.' },
        { status: 500 }
      );
    }

    const prompt = buildPrompt(tasksToSend);
    let resp: Response;
    try {
      resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                'Ты опытный инженер-планировщик. Отвечай конкретно, на русском языке, без воды.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json({ error: `DeepSeek fetch failed: ${message}` }, { status: 502 });
    }

    const respText = await resp.text();

    if (!resp.ok) {
      return NextResponse.json(
        { error: `DeepSeek API error: HTTP ${resp.status}. Body (preview): ${respText.slice(0, 500)}` },
        { status: 502 }
      );
    }

    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = respText ? (JSON.parse(respText) as typeof data) : {};
    } catch {
      return NextResponse.json(
        { error: `DeepSeek returned invalid JSON. Body (preview): ${respText.slice(0, 500)}` },
        { status: 502 }
      );
    }
    const analysis = data.choices?.[0]?.message?.content?.trim();
    if (!analysis) {
      return NextResponse.json({ error: 'DeepSeek вернул пустой ответ.' }, { status: 502 });
    }

    return NextResponse.json({ analysis });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

