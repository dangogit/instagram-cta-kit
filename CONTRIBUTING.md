# Contributing

Contributions are welcome through GitHub issues and pull requests.

Before opening a pull request:

1. Use HookMyApp or documented Meta Instagram APIs.
2. Keep live replies deterministic.
3. Do not add credentials, webhook payloads, message content, or local state.
4. Preserve the durable-inbox acknowledgement boundary.
5. Add regression coverage for behavioral changes.
6. Run `npm test`, `npm audit --omit=dev`, and `npm run pack:check`.

Security reports belong in a private advisory, not a public issue. See `SECURITY.md`.
