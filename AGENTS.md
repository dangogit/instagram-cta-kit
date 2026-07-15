# Contributor Instructions

- Never commit `.env`, access tokens, Meta app secrets, webhook payloads, or `state/`.
- Use the official Meta Instagram API only. Do not add browser automation, scraping, or private endpoints.
- Keep the message path deterministic. AI may help configure routes, but it must not generate live replies without an explicit product change.
- Follow-up messages must be triggered by a fresh user action and must respect Meta messaging windows.
- Keep polling as a fallback. Prefer signed webhooks for production.
- Run `npm test`, `npm run doctor`, `npm run validate:routes`, and `npm run pack:check` before release.
- Do not use em dashes in documentation, code comments, commits, or release notes.
