import { NextResponse } from 'next/server';

/** Всегда Node + свежие env на Vercel; иначе иногда «теряется» прокси до n8n. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

function parseWebhookUrlList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((u) => /^https?:\/\//i.test(u));
}

/** Один или несколько Production URL webhook (через запятую или перенос строки). */
function resolveN8nAnalyzeWebhookUrls(): string[] {
  const primary = parseWebhookUrlList(process.env.N8N_ANALYZE_WEBHOOK_URL);
  if (primary.length) return primary;
  return parseWebhookUrlList(process.env.NEXT_PUBLIC_N8N_ANALYZE_WEBHOOK_URL);
}

/** Заголовок Authorization к вашему n8n (если webhook за прокси с проверкой). Значение целиком, напр. Bearer xxx или Basic xxx */
function buildN8nOutboundHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'xer-schedule-viewer/1.0',
  };
  const auth = process.env.N8N_ANALYZE_WEBHOOK_AUTH?.trim();
  if (auth) {
    headers.Authorization = auth;
  }
  return headers;
}

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

/** Проверка, видит ли деплой URL n8n (без раскрытия адреса). */
export async function GET() {
  const urls = resolveN8nAnalyzeWebhookUrls();
  /** На Vercel: production = основной домен (plan.alenos.ru), preview = *.vercel.app */
  const vercelEnv = process.env.VERCEL_ENV ?? null;
  const deepseekApiKeyConfigured = !!process.env.DEEPSEEK_API_KEY?.trim();
  const n8nOutboundAuthConfigured = !!process.env.N8N_ANALYZE_WEBHOOK_AUTH?.trim();

  let hint: string;
  if (urls.length > 0) {
    hint = 'Webhook URL задан; при анализе на сайте запрос уходит на n8n первым.';
  } else if (vercelEnv === 'production') {
    hint =
      'Частая причина: переменные заданы только для Preview (*.vercel.app), но не для Production (ваш домен). В Vercel → Settings → Environment Variables откройте N8N_ANALYZE_WEBHOOK_URL и DEEPSEEK_API_KEY → включите чекбокс Production → Save → Redeploy.';
  } else {
    hint =
      'Задайте N8N_ANALYZE_WEBHOOK_URL для этой среды (Preview/Development) и сделайте Redeploy. Для основного домена обязательно продублируйте те же переменные для Production.';
  }

  return NextResponse.json({
    ok: true,
    vercelEnv,
    n8nWebhookConfigured: urls.length > 0,
    n8nWebhookUrlCount: urls.length,
    deepseekApiKeyConfigured,
    n8nOutboundAuthConfigured,
    hint,
  });
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    let body: AnalyzeRequest = {};
    try {
      body = raw ? (JSON.parse(raw) as AnalyzeRequest) : {};
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    if (tasks.length === 0) {
      return NextResponse.json({ error: 'Нет данных задач для анализа.' }, { status: 400 });
    }

    // Чтобы n8n/DeepSeek возвращали ответ быстрее (и не получали "Load failed"),
    // уменьшаем размер входных данных:
    // - ограничиваем количество задач
    // - подрезаем длинные поля текста (task_name/resources/wbs_id)
    const capTasks = 80;
    const tasksToSend = tasks.slice(0, capTasks).map((t) => ({
      id: t.id,
      task_code: t.task_code,
      task_name: typeof t.task_name === 'string' ? t.task_name.slice(0, 120) : '',
      start: t.start,
      end: t.end,
      progress: t.progress,
      isCritical: t.isCritical,
      resources: typeof t.resources === 'string' ? t.resources.slice(0, 200) : t.resources,
      wbs_id: typeof t.wbs_id === 'string' ? t.wbs_id.slice(0, 80) : t.wbs_id,
    }));
    const n8nUrls = resolveN8nAnalyzeWebhookUrls();
    let n8nFailure: string | undefined;
    let n8nTimedOut = false;

    if (n8nUrls.length > 0) {
      // Ограничиваем время, чтобы сайт на Production не отдавал "Load failed".
      const n8nSignal = AbortSignal.timeout(20000);
      const payload = JSON.stringify({ tasks: tasksToSend });
      const headers = buildN8nOutboundHeaders();

      try {
        for (let i = 0; i < n8nUrls.length; i++) {
          const n8nUrl = n8nUrls[i];
          try {
            const resp = await fetch(n8nUrl, {
              method: 'POST',
              headers,
              body: payload,
              signal: n8nSignal,
              cache: 'no-store',
              redirect: 'follow',
            });

            const text = await resp.text();
            let data: { analysis?: string; error?: string };
            try {
              data = text ? (JSON.parse(text) as { analysis?: string; error?: string }) : {};
            } catch {
              n8nFailure = `n8n returned non-JSON (HTTP ${resp.status}). Preview: ${text.slice(0, 200)}`;
              data = {};
            }

            if (resp.ok) {
              const analysis = data.analysis;
              if (analysis) {
                const res = NextResponse.json({ analysis, source: 'n8n' });
                res.headers.set('X-Analyze-Source', 'n8n');
                return res;
              }
              n8nFailure = data.error || 'n8n returned empty analysis.';
            } else {
              n8nFailure = data.error || `n8n error (HTTP ${resp.status}).`;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            if (
              error instanceof Error &&
              (error.name === 'AbortError' || message.toLowerCase().includes('aborted'))
            ) {
              n8nTimedOut = true;
              n8nFailure = 'n8n timeout (20s).';
              break;
            }
            n8nFailure = `n8n request failed: ${message}`;
          }

          if (i < n8nUrls.length - 1) {
            n8nFailure = `${n8nFailure || 'failed'} (пробуем следующий URL…)`;
          }
        }
      } finally {}
    }

    // Если n8n отвалился по таймауту — лучше вернуть контролируемую ошибку,
    // чем ждать ещё и DeepSeek (это снова приведёт к "Load failed").
    if (n8nTimedOut) {
      return NextResponse.json(
        { error: 'n8n timeout (20s).' },
        { status: 504 }
      );
    }

    // Если n8n URL задан, но анализ не получился — лучше вернуть ошибку сразу,
    // чем снова ждать DeepSeek и снова ловить "Load failed" на клиенте.
    if (n8nUrls.length > 0) {
      return NextResponse.json(
        { error: n8nFailure || 'n8n returned empty analysis.' },
        { status: 502 }
      );
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
      // Чтобы не получать "Load failed" в браузере из-за длительного ожидания ответа.
      const deepseekSignal = AbortSignal.timeout(12000);
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
        cache: 'no-store',
        signal: deepseekSignal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || message.toLowerCase().includes('aborted'))
      ) {
        return NextResponse.json({ error: 'DeepSeek timeout (12s).' }, { status: 504 });
      }
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

    const n8nNote =
      n8nUrls.length > 0 && n8nFailure
        ? `Запрос в n8n не дал анализ: ${n8nFailure} Использован запасной вызов DeepSeek.`
        : n8nUrls.length === 0
          ? `Запрос не отправлялся в n8n: URL webhook не задан в этой среде (Vercel: ${process.env.VERCEL_ENV ?? 'local'}). Если на *.vercel.app работает, а на основном домене нет — в Environment Variables включите Production для N8N_ANALYZE_WEBHOOK_URL и сделайте Redeploy. GET /api/analyze-schedule — поле n8nWebhookConfigured.`
          : undefined;

    const res = NextResponse.json({
      analysis,
      source: 'deepseek',
      ...(n8nNote ? { n8nNote } : {}),
    });
    res.headers.set('X-Analyze-Source', 'deepseek');
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
