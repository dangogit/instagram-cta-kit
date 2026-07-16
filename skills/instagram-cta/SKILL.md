---
name: instagram-cta
description: Set up, validate, and operate the self-hosted Instagram CTA Kit using the official Meta Instagram API.
---

# Instagram CTA Kit

Use this skill for comment-keyword DMs, Story reply automation, guide delivery, or local Instagram CTA hosting.

## Safety Rules

- Use the official Meta Instagram API only.
- Never request an Instagram password or automate the Instagram website.
- Never print, commit, or paste access tokens, app secrets, `.env`, webhook payloads, or local state.
- Do not enable live delivery until doctor, route validation, health, and a dry-run pass.
- Keep background follow delivery disabled. Recheck follow state only after a fresh user message or button tap.
- Confirm the exact account and exact route copy before enabling live messages.

## Setup

1. Verify Node.js 20 or newer.
2. Initialize a config directory:

```bash
npx github:dangogit/instagram-cta-kit init --dir ./instagram-cta --locale en --mode polling
```

3. Tell the user to put secrets directly into `.env`. Do not ask them to paste secrets into chat.
4. Run `npx github:dangogit/instagram-cta-kit doctor --dir ./instagram-cta`.
5. Add a route:

```bash
npx github:dangogit/instagram-cta-kit route add CHECKLIST https://example.com/checklist \
  --dir ./instagram-cta \
  --campaign-id stable-content-slug
```

6. Validate and start in dry-run mode:

```bash
npx github:dangogit/instagram-cta-kit routes validate --dir ./instagram-cta --check-guides
npx github:dangogit/instagram-cta-kit start --dir ./instagram-cta
```

7. Verify `GET /health` reports `ok:true`, `dry_run:true`, and no poll error.
8. Only after the user approves live delivery, set `DRY_RUN=0`, restart, and run one controlled keyword test.

## Operating Modes

- Polling is appropriate for a personal computer without a public URL. The computer must stay awake.
- Webhooks are preferred for production. Require public HTTPS, signature verification, and the Meta subscriptions `comments`, `messages`, and `messaging_postbacks`.

## Completion Proof

Report local configuration, route validation, runtime health, dry-run delivery, and separately any explicitly authorized live delivery.
