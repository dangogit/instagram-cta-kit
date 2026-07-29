# Instagram CTA Kit by Daniel Goldman

Self-hosted Instagram comment and DM automation for creators, teachers, and small teams.

Someone comments a keyword, replies to a Story, or sends a DM. The kit asks for confirmation, optionally checks whether they follow the account, and sends the right guide. Replies are deterministic. No model writes live messages.

```text
Instagram comment, DM, or Story reply
  -> HookMyApp or your own Meta app
  -> signed webhook
  -> durable local inbox
  -> exact keyword route
  -> public reply and private DM
  -> retry, recovery, or dead-letter queue
```

HookMyApp is the recommended setup for students. It connects Instagram through Meta OAuth, gives you API credentials, signs webhooks, and removes the need to build a Meta app. If you already have a Meta app, the same CTA engine works directly with it.

## What it handles

- Comment keyword to public reply and private DM
- DM and Story reply keywords
- Quick reply buttons
- Optional follower check after a fresh user action
- English and Hebrew routes
- Exact token matching, aliases, and safe one-character typo recovery
- Signed HookMyApp and Meta webhooks
- Polling fallback and six-hour reconciliation with a five-minute retry after transient failures
- Durable events written to disk before webhook acknowledgement
- Retry with exponential backoff
- Crash recovery and a dead-letter queue
- Duplicate protection across restarts
- Campaign attribution with opaque delivery IDs
- No runtime dependencies beyond Node.js 20 or newer

## Choose your provider

| Provider | Meta app required | Best for |
|---|---:|---|
| HookMyApp | No | Students, creators, and the fastest setup |
| Direct Meta | Yes | Teams that already operate their own approved Meta app |

Both providers use the official Instagram API. The difference is who manages the Meta connection and credentials.

## HookMyApp quick start

Requirements:

- Node.js 20 or newer
- An Instagram Business or Creator account
- A HookMyApp account
- A machine that stays online, or a small server

Install both CLIs:

```bash
npm install -g @gethookmyapp/cli
npm install -g github:dangogit/instagram-cta-kit
```

Connect Instagram:

```bash
hookmyapp login
hookmyapp channels connect instagram
hookmyapp channels list
```

Initialize the CTA project:

```bash
instagram-cta init --dir ./my-instagram-cta --provider hookmyapp --locale en
hookmyapp channels env ch_YOUR_CHANNEL --write ./my-instagram-cta/.env
hookmyapp channels webhook hmac show ch_YOUR_CHANNEL
```

Put the HMAC value from the last command in `WEBHOOK_HMAC_SECRET` inside `./my-instagram-cta/.env`. Keep it private.

Add a real guide route:

```bash
instagram-cta route add CHECKLIST https://example.com/checklist \
  --dir ./my-instagram-cta \
  --campaign-id first-checklist

instagram-cta doctor --dir ./my-instagram-cta --live
instagram-cta routes validate --dir ./my-instagram-cta --check-guides
```

Start in dry-run mode:

```bash
instagram-cta start --dir ./my-instagram-cta
```

In another terminal, forward HookMyApp webhooks to the local server:

```bash
hookmyapp channels listen ch_YOUR_CHANNEL --port 18787 --path /webhook
```

Comment the keyword from a test account. Check:

```bash
instagram-cta status --dir ./my-instagram-cta
```

When the dry run is correct, set `DRY_RUN=0`, restart the CTA service, and test one real comment end to end.

For a server with a public HTTPS URL, configure the permanent callback:

```bash
hookmyapp channels webhook set ch_YOUR_CHANNEL \
  --url https://your-domain.example/webhook \
  --verify-token YOUR_VERIFY_TOKEN
```

Replace `YOUR_VERIFY_TOKEN` with the value already stored in `.env`. Full setup and troubleshooting are in [docs/hookmyapp-setup.md](docs/hookmyapp-setup.md).

## Direct Meta setup

If you already have a Meta app:

```bash
instagram-cta init --dir ./my-instagram-cta --provider meta --locale en
```

Add your app secret, account ID, and long-lived Instagram token to `.env`. Then follow [docs/meta-setup.md](docs/meta-setup.md). Direct Meta supports polling on a computer without a public URL, or signed webhooks on a public HTTPS URL.

## CLI

```bash
instagram-cta init [--provider hookmyapp|meta] [--locale en|he] [--mode polling|webhook]
instagram-cta doctor [--live]
instagram-cta route add KEYWORD URL --campaign-id ID
instagram-cta routes validate [--check-guides]
instagram-cta status
instagram-cta recover
instagram-cta dead-letter list
instagram-cta dead-letter retry EVENT_KEY
instagram-cta dead-letter resolve EVENT_KEY --reason TEXT
instagram-cta start
```

Every command accepts `--dir PATH`.

Hebrew route example:

```bash
instagram-cta route add צקליסט https://example.com/he/checklist \
  --dir ./my-instagram-cta \
  --campaign-id hebrew-checklist \
  --locale he
```

Follower gating is optional:

```bash
instagram-cta route add CHECKLIST https://example.com/checklist \
  --dir ./my-instagram-cta \
  --campaign-id first-checklist \
  --follow-gate
```

Follower checks run after a user comment, message, or button tap. Background follow delivery stays off by default.

## Recovery

Each webhook event is saved under `state/inbox/pending` before the server returns `200`. The worker moves it through these states:

```text
pending -> processing -> completed
                    -> pending with backoff
                    -> dead-letter
```

If the process crashes while an event is under `processing`, it returns to `pending` on startup. Permanent provider rejections go to `dead-letter` with sanitized error metadata.

Useful commands:

```bash
instagram-cta status --dir ./my-instagram-cta
instagram-cta recover --dir ./my-instagram-cta
instagram-cta dead-letter list --dir ./my-instagram-cta
instagram-cta dead-letter retry EVENT_KEY --dir ./my-instagram-cta
instagram-cta dead-letter resolve EVENT_KEY --reason "Instagram rejected this recipient" --dir ./my-instagram-cta
```

Do not mark a dead letter resolved until you have checked whether the user received the public reply and DM.

## Route format

```json
{
  "keyword": "GUIDE",
  "campaign_id": "stable-content-slug",
  "guide_url": "https://example.com/guide",
  "intro_text": "Want me to send the guide?",
  "reply_text": "Here is the guide:\nhttps://example.com/guide",
  "public_reply_text": "Sent you a DM",
  "requires_follow": false
}
```

The guide URL must appear exactly inside `reply_text`. The kit replaces it at delivery time with an attributed URL.

If the same keyword routes to different guides, each route needs non-overlapping `media_ids`. Ambiguous DMs are ignored instead of guessed.

## Docker

```bash
instagram-cta init --provider hookmyapp
docker compose up -d --build
docker compose logs -f
```

The container runs as a non-root user with a read-only root filesystem. Local state lives in the `instagram-cta-state` volume. Back up that volume before moving or replacing the host.

The app refuses a non-loopback HTTP bind unless `ALLOW_INSECURE_HTTP=1` is explicit. Docker Compose sets it because the published host port is still bound to `127.0.0.1`. Put HTTPS in front before making the webhook public.

## Production checklist

Before setting `DRY_RUN=0`:

1. `instagram-cta doctor --live` passes.
2. Route validation and guide URL checks pass.
3. `/health` reports an empty pending queue and no dead letters.
4. The webhook URL is public HTTPS and signature verification is enabled.
5. One controlled test proves the public reply, opt-in DM, button tap, and final guide.
6. The machine will stay online.

## Limits

This release is for one Instagram professional account and one process using one state directory. It is not a multi-tenant SaaS or a high-availability cluster.

Instagram can reject a private reply even when the public comment reply succeeds. The recovery queue keeps the failure visible, but it cannot override Instagram policy or make an undeliverable recipient deliverable.

HookMyApp and Meta can also limit history depth. Reconciliation is a safety net, not proof that unlimited old history can always be recovered. Keep backups of the state directory and monitor `/health`.

Delivery is at least once. If the process dies after Instagram accepts a send but before the local success record reaches disk, recovery may send that step again. The provider API does not offer an idempotency key for every Instagram reply operation.

Meta messaging rules and permissions change. Review the current platform rules before live delivery.

## Security

- Never commit `.env`, `routes.json`, `state/`, tokens, secrets, or webhook payloads.
- Keep `LOG_WEBHOOK_CONTENT=0` unless you are debugging on a protected machine.
- Bind the service to localhost unless it sits behind HTTPS.
- Rotate any credential that appears in chat, a screenshot, an issue, or Git history.
- Treat `CTA_ADMIN_TOKEN` like a password. It controls retry and dead-letter actions.
- Pending and failed queue records contain normalized message text, quick-reply payloads, Instagram IDs, and Story URLs needed for replay. Treat `state/` and backups as private data.

See [SECURITY.md](SECURITY.md).

## Background services

Templates are included for macOS launchd and Linux systemd. Windows users can run the same `start` command from Task Scheduler. Replace the template paths and Node binary before installing a service.

## Agent skill

The repo includes `skills/instagram-cta/SKILL.md`. Coding agents can initialize the kit, validate routes, inspect health, and operate recovery without reading secrets into chat.

## License

MIT

Built by [Daniel Goldman](https://danielthegoldman.com), [@danielthegoldman](https://www.instagram.com/danielthegoldman/).
