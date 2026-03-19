# Vercel: Preview работает, основной домен — нет

URL вида `*.vercel.app` — это **Preview** (ветка/PR). Ваш домен **plan.alenos.ru** — это **Production**.

У каждой переменной окружения в Vercel можно отдельно отметить среды: **Production**, **Preview**, **Development**.

## Что сделать

1. Vercel → проект **xer-schedule-viewer** → **Settings** → **Environment Variables**.
2. Для каждой нужной переменной (`N8N_ANALYZE_WEBHOOK_URL`, `DEEPSEEK_API_KEY`, при необходимости `N8N_ANALYZE_WEBHOOK_AUTH`):
   - откройте переменную **или** создайте заново с тем же значением;
   - включите чекбокс **Production** (не только Preview);
   - **Save**.
3. **Deployments** → на последнем production-деплое → **⋯** → **Redeploy**.

## Проверка

- На **plan.alenos.ru**: откройте `https://plan.alenos.ru/api/analyze-schedule`  
  В JSON должно быть `"vercelEnv": "production"` и `"n8nWebhookConfigured": true`.
- На preview-деплое обычно `"vercelEnv": "preview"`.

Если на production `n8nWebhookConfigured: false`, а на preview `true` — переменная не продублирована в Production.
