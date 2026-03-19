# Анализ графика через n8n (DeepSeek)

Если анализ через Vercel API падает (таймаут, лимиты), можно перенести вызов DeepSeek в n8n.

## Шаги

1. **Импорт workflow**
   - В n8n: Workflows → Import from File → выберите `analyze-schedule-deepseek.json`.

2. **Ключ DeepSeek (узел HTTP Request, не Code)**
   - Узел **DeepSeek API** в этом файле — тип **HTTP Request** (иконка земного шара), внутри **нет** JavaScript.
   - Если в executions ошибка **`process is not defined`** — у вас в редакторе стоит **Code** с `process.env` или старый импорт. Заново импортируйте `analyze-schedule-deepseek.json` **поверх** workflow или удалите ошибочный узел и добавьте **HTTP Request** вручную по URL из JSON.
   - Откройте **DeepSeek API** → в заголовке **Authorization** замените `Bearer PASTE_YOUR_DEEPSEEK_KEY_HERE` на **`Bearer sk-ваш-ключ`**.
   - По желанию вместо ключа в заголовке можно использовать **Credentials → Header Auth** и убрать строку Authorization из узла (чтобы не дублировать).

3. **Активация и URL webhook**
   - Сохраните workflow и нажмите **Activate**.
   - Откройте узел **Webhook** и скопируйте **Production URL** (например `https://your-n8n.com/webhook/analyze-schedule`).

4. **Настройка сайта (важно для Production)**
   - В Vercel → **Settings → Environment Variables** для окружения **Production** задайте один из вариантов:
     - **Предпочтительно:** `N8N_ANALYZE_WEBHOOK_URL` = полный **Production** URL webhook из шага 3 (без завершающего `/`). Можно указать **несколько URL через запятую** — сайт переберёт их по очереди, если первый недоступен.
     - Либо: `NEXT_PUBLIC_N8N_ANALYZE_WEBHOOK_URL` (то же правило; после изменения обязателен **Redeploy**).
   - Если webhook n8n закрыт прокси с заголовком **Authorization**, задайте **`N8N_ANALYZE_WEBHOOK_AUTH`** — полное значение заголовка (например `Bearer ваш-токен` или `Basic …`).
   - Обязательно нажмите **Redeploy** после добавления или смены переменных.
   - **Проверка:** в браузере откройте `https://ваш-сайт/api/analyze-schedule` (GET). В ответе должно быть `"n8nWebhookConfigured": true`. Если `false` — переменная не подхватилась (часто забыли Production или Redeploy).
   - Если анализ работает, но в n8n пусто: **«Технические детали»** на сайте — `Источник ответа: deepseek` и `n8nNote`; заголовок ответа `X-Analyze-Source: deepseek` (в DevTools → Network).

## Формат запроса/ответа

- **POST** тело: `{ "tasks": [ { "id", "task_code", "task_name", "start", "end", "progress", "isCritical?", "resources?", "wbs_id?" }, ... ] }`
- **Ответ 200:** `{ "analysis": "текст от DeepSeek" }`
- **Ошибка:** `{ "error": "строка" }`
