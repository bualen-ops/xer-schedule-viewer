# Анализ графика через n8n (DeepSeek)

Если анализ через Vercel API падает (таймаут, лимиты), можно перенести вызов DeepSeek в n8n.

## Шаги

1. **Импорт workflow**
   - В n8n: Workflows → Import from File → выберите `analyze-schedule-deepseek.json`.

2. **Ключ DeepSeek**
   - **Проще всего:** откройте узел **DeepSeek API** → в заголовках найдите **Authorization** и замените значение `Bearer PASTE_YOUR_DEEPSEEK_KEY_HERE` на **`Bearer sk-ваш-реальный-ключ`** (слово `Bearer` и пробел обязательны).
   - **Безопаснее для команды:** вместо ключа в узле используйте **Credentials → Header Auth** и подключите credential к узлу (тогда удалите строку Authorization из заголовков узла, чтобы не дублировать).
   - Не коммитьте workflow с реальным ключом в Git.

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
