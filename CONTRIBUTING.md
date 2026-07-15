# Contributing

Contributions are welcome through GitHub issues and pull requests.

Before opening a pull request:

1. Use only documented Meta Instagram APIs.
2. Keep live replies deterministic.
3. Do not add credentials, webhook payloads, message content, or local state.
4. Add regression coverage for behavioral changes.
5. Run `npm test`, `npm audit --omit=dev`, and `npm run pack:check`.

Security reports belong in a private advisory, not a public issue. See `SECURITY.md`.

