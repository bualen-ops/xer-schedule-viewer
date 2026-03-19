# Анализ графика через n8n (DeepSeek)

Если анализ через Vercel API падает (таймаут, лимиты), можно перенести вызов DeepSeek в n8n.

## Шаги

1. **Импорт workflow**
   - В n8n: Workflows → Import from File → выберите `analyze-schedule-deepseek.json`.

2. **Учётные данные DeepSeek (обязательно)**
   - В n8n: **Credentials** → Add → **Header Auth**.
   - Имя: **`DeepSeek API Key`** (как в workflow — так проще выбрать узел).
   - **Header Name:** `Authorization`
   - **Header Value:** `Bearer sk-ваш-ключ-deepseek` (полная строка с `Bearer `).
   - Откройте узел **DeepSeek API** → в поле **Credential** выберите созданный **DeepSeek API Key**.
   - Не полагайтесь на `$env.DEEPSEEK_API_KEY` в n8n 2.11 — в выражениях окружение часто недоступно; credential надёжнее.

3. **Активация и URL webhook**
   - Сохраните workflow и нажмите **Activate**.
   - Откройте узел **Webhook** и скопируйте **Production URL** (например `https://your-n8n.com/webhook/analyze-schedule`).

4. **Настройка сайта**
   - В Vercel (или в `.env.local`): добавьте переменную окружения:
     - **Name:** `NEXT_PUBLIC_N8N_ANALYZE_WEBHOOK_URL`
     - **Value:** полный URL webhook из шага 3 (без завершающего слэша).
   - Сделайте Redeploy. Кнопка «Анализ графика с помощью ИИ DeepSeek» будет отправлять запрос в n8n вместо встроенного API.

## Формат запроса/ответа

- **POST** тело: `{ "tasks": [ { "id", "task_code", "task_name", "start", "end", "progress", "isCritical?", "resources?", "wbs_id?" }, ... ] }`
- **Ответ 200:** `{ "analysis": "текст от DeepSeek" }`
- **Ошибка:** `{ "error": "строка" }`
