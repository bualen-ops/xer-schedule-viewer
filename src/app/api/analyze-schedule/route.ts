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
    const body = (await req.json()) as AnalyzeRequest;
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    if (tasks.length === 0) {
      return NextResponse.json({ error: 'Нет данных задач для анализа.' }, { status: 400 });
    }

    const tasksToSend = tasks.slice(0, 200);

    // Если настроен n8n, проксируем запрос туда (и возвращаем результат обратно в сайт).
    // Так гарантируем отсутствие CORS и то, что запрос реально попадает в n8n.
    const n8nUrl = process.env.N8N_ANALYZE_WEBHOOK_URL;
    if (n8nUrl && typeof n8nUrl === 'string' && n8nUrl.trim() !== '') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
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
          return NextResponse.json(
            { error: `n8n вернул не JSON ответ (HTTP ${resp.status}).` },
            { status: 502 }
          );
        }

        if (!resp.ok) {
          return NextResponse.json(
            { error: data.error || `n8n error (HTTP ${resp.status}).` },
            { status: 502 }
          );
        }

        const analysis = data.analysis;
        if (!analysis) {
          return NextResponse.json(
            { error: data.error || 'n8n вернул пустой ответ.' },
            { status: 502 }
          );
        }

        return NextResponse.json({ analysis });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message.toLowerCase().includes('aborted')) {
          return NextResponse.json({ error: 'n8n timeout (45s).' }, { status: 504 });
        }
        return NextResponse.json({ error: `n8n request failed: ${message}` }, { status: 502 });
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
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
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

    if (!resp.ok) {
      const errText = await resp.text();
      return NextResponse.json(
        { error: `DeepSeek API error: ${resp.status} ${errText}` },
        { status: 502 }
      );
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
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

