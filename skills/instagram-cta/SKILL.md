---
name: instagram-cta
description: Set up, validate, and operate Instagram CTA Kit with HookMyApp or a direct Meta app.
---

# Instagram CTA Kit

Use this skill for comment keywords, Story replies, guide delivery, health checks, and failed-delivery recovery.

## Safety rules

- Use HookMyApp or the official Meta Instagram API.
- Never request an Instagram password or automate the Instagram website.
- Never print, commit, or paste access tokens, secrets, `.env`, webhook payloads, or local state.
- Keep `DRY_RUN=1` until doctor, routes, health, and a controlled simulation pass.
- Keep background follow delivery disabled. Recheck follow state after a fresh user action.
- Confirm the account and route copy before enabling live messages.
- A webhook acknowledgement is not delivery proof. Check the queue and the real Instagram reply.

## Recommended setup

```bash
npm install -g @gethookmyapp/cli
npm install -g github:dangogit/instagram-cta-kit
hookmyapp login
hookmyapp channels connect instagram
instagram-cta init --dir ./instagram-cta --provider hookmyapp --locale en
```

Write the selected HookMyApp channel env to the generated `.env`. Add the webhook HMAC secret without displaying it in chat.

Then:

```bash
instagram-cta doctor --dir ./instagram-cta --live
instagram-cta route add CHECKLIST https://example.com/checklist \
  --dir ./instagram-cta \
  --campaign-id stable-content-slug
instagram-cta routes validate --dir ./instagram-cta --check-guides
instagram-cta start --dir ./instagram-cta
```

Use `hookmyapp channels listen` for local webhook testing. Use a permanent HookMyApp webhook URL for a server.

## Direct Meta

Use `instagram-cta init --provider meta` and follow `docs/meta-setup.md`. Require a signed webhook or polling with valid Instagram credentials.

## Recovery

Check:

```bash
instagram-cta status --dir ./instagram-cta
instagram-cta recover --dir ./instagram-cta
instagram-cta dead-letter list --dir ./instagram-cta
```

Retry a dead letter only after checking the provider error and current recipient state. Resolve it only when the failure is confirmed permanent or handled outside the automation.

## Completion proof

Report provider, route validation, runtime health, queue counts, dry-run result, and separately any authorized live comment and DM proof.
