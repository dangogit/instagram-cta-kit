# Contributor Instructions

- Never commit `.env`, access tokens, HookMyApp or Meta secrets, webhook payloads, or `state/`.
- Use HookMyApp or the official Meta Instagram API. Do not add browser automation, scraping, or private endpoints.
- Keep the message path deterministic. AI may help configure routes, but it must not generate live replies without an explicit product change.
- Follow-up messages must be triggered by a fresh user action and must respect Meta messaging windows.
- Persist normalized events before acknowledging webhooks. Keep polling and reconciliation as recovery paths.
- Prefer signed webhooks for production.
- Run `npm test`, `npm run doctor`, `npm run validate:routes`, and `npm run pack:check` before release.
- Do not use em dashes in documentation, code comments, commits, or release notes.
