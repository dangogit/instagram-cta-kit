# Instagram CTA Kit

Self-hosted keyword automation for Instagram comments, DMs, Story replies, and guide delivery. It uses the official Meta Instagram API and runs on your own Mac, Windows PC, Linux machine, Raspberry Pi, or server.

The message path is deterministic. There is no AI model generating live replies.

## What It Does

```text
Comment, DM, or Story reply
  -> exact keyword match
  -> public reply and private opt-in question
  -> user taps a quick reply
  -> optional follower check
  -> attributed guide link
  -> local event log and optional sanitized analytics
```

Features:

- Comment keyword to private reply.
- Direct DM and Story reply keywords.
- Quick reply buttons.
- Optional follower gate, rechecked only after a fresh user action by default.
- Exact token matching, aliases, Hebrew keywords, and safe one-character typo recovery.
- Polling fallback with cursor pagination.
- Signed Meta webhooks.
- Duplicate protection across restarts.
- Campaign attribution with opaque HMAC delivery IDs.
- English and Hebrew defaults.
- No runtime dependencies beyond Node.js 20 or newer.

## Requirements

- Node.js 20 or newer.
- An Instagram Business or Creator account.
- A Meta app configured for the Instagram API.
- An Instagram user access token.
- The `instagram_business_basic`, `instagram_business_manage_comments`, and `instagram_business_manage_messages` permissions for Instagram Login.
- A public HTTPS URL when using webhooks. Polling mode does not need a public URL.

Use only the official Meta API. Do not use browser automation, scraping, or private Instagram endpoints.

Standard Access is enough for accounts you own or manage and have added to the Meta app. Serving professional accounts you do not own or manage requires Advanced Access and App Review. Follow the [Meta setup checklist](docs/meta-setup.md) before switching off dry-run mode.

## Quick Start

```bash
git clone https://github.com/dangogit/instagram-cta-kit.git
cd instagram-cta-kit
npm install
node bin/instagram-cta.mjs init --locale en --mode polling
```

Edit `.env` with your Meta credentials. Leave `DRY_RUN=1` for the first test.

Then:

```bash
npm run doctor
npm run validate:routes
npm start
```

Open another terminal:

```bash
curl http://127.0.0.1:18787/health
```

When the configuration is correct, change `DRY_RUN=0` and restart.

With placeholder credentials, the server starts for local webhook simulation but polling stays paused. Add a valid `IG_USER_ID` and `IG_ACCESS_TOKEN` to test read-only polling while `DRY_RUN=1` still prevents outbound messages.

### Run through npx

The GitHub repository can be used directly:

```bash
npx github:dangogit/instagram-cta-kit init --dir ./my-instagram-cta
npx github:dangogit/instagram-cta-kit doctor --dir ./my-instagram-cta
npx github:dangogit/instagram-cta-kit start --dir ./my-instagram-cta
```

Keep the terminal open, or install it as a background process using Docker, launchd, systemd, or Windows Task Scheduler.

For a persistent background service, clone the repository instead of depending on an ephemeral npx cache.

## CLI

```bash
instagram-cta init [--dir PATH] [--locale en|he] [--mode polling|webhook]
instagram-cta doctor [--dir PATH] [--live]
instagram-cta route add KEYWORD URL --campaign-id ID
instagram-cta routes validate [--check-guides]
instagram-cta start [--dir PATH]
```

Add a route:

```bash
npx github:dangogit/instagram-cta-kit route add CHECKLIST https://example.com/checklist \
  --campaign-id my-first-checklist
```

Hebrew:

```bash
npx github:dangogit/instagram-cta-kit route add צקליסט https://example.com/he/checklist \
  --campaign-id hebrew-checklist \
  --locale he
```

Follower gate is opt-in:

```bash
npx github:dangogit/instagram-cta-kit route add CHECKLIST https://example.com/checklist \
  --campaign-id my-first-checklist \
  --follow-gate
```

User-facing messages can be overridden with `--intro-text`, `--guide-text`, `--public-text`, `--non-follower-text`, and `--unknown-follower-text`.

## Polling or Webhooks

Polling is easiest on a personal computer:

- No public URL is needed.
- New comments and DMs are checked every 60 seconds by default.
- The computer must stay online and awake.

Webhooks are recommended for production:

- Events arrive in real time.
- Meta must reach `https://your-domain.example/webhook`.
- Subscribe the app to `comments`, `messages`, and `messaging_postbacks`.
- The service verifies `X-Hub-Signature-256` using `META_APP_SECRET`.

You can use Cloudflare Tunnel, ngrok, a reverse proxy, or a public server. Never expose an unsigned webhook handler.

## Docker

```bash
node bin/instagram-cta.mjs init --mode polling
docker compose up -d --build
docker compose logs -f
```

The container port is bound to localhost by default. Put a TLS reverse proxy or tunnel in front of it for Meta webhooks.

Docker runs as a non-root user with a read-only root filesystem. Runtime state is stored in the Compose volume named `instagram-cta-state`. Back up the resolved Docker volume before replacing a host or intentionally removing Docker volumes.

## Running in the Background

### macOS

Use `templates/com.example.instagram-cta.plist`. Replace the repository path and `REPLACE_WITH_NODE_PATH` with the output of `command -v node`, copy it to `~/Library/LaunchAgents/`, then load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.instagram-cta.plist
launchctl kickstart -k gui/$(id -u)/com.example.instagram-cta
```

Prevent the Mac from sleeping while the automation is expected to run.

### Linux

Use `templates/instagram-cta.service` with systemd. Replace `REPLACE_WITH_NODE_PATH` with the output of `command -v node`, or use Docker Compose.

### Windows

Create a Task Scheduler task that starts at login and runs `node bin/instagram-cta.mjs start --dir C:\path\to\instagram-cta-kit`. Set the working directory to the cloned repository.

## Route Contract

```json
{
  "keyword": "GUIDE",
  "campaign_id": "stable-content-slug",
  "guide_url": "https://example.com/guide",
  "intro_text": "Want me to send the guide?",
  "reply_text": "Here is the guide:\nhttps://example.com/guide",
  "public_reply_text": "Sent you a DM ✨",
  "requires_follow": false
}
```

The guide URL must appear exactly inside `reply_text`. At delivery time it is replaced with an attributed URL containing `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `cta`, and an opaque `delivery_id`.

The same keyword can be used for different posts only when every overlapping route has non-overlapping `media_ids`. The post ID is carried into quick replies so the correct guide is selected. A keyword that is ambiguous without post context is ignored in a direct DM or Story reply instead of guessing.

## Privacy and Security

- `.env`, `routes.json`, `state/`, webhook payloads, and access tokens are ignored by Git.
- Docker build context excludes `.env`, `routes.json`, local state, logs, Git history, and package archives.
- Webhook message content is not logged unless `LOG_WEBHOOK_CONTENT=1` is explicitly set.
- Ignored DM text is never written to the event log.
- PostHog is disabled by default.
- When enabled, PostHog receives the opaque delivery ID and campaign metadata, not email addresses or Instagram user IDs.
- Local state contains Instagram-scoped identifiers needed for deduplication and pending conversations. Keep the machine and backups protected. Delete state according to your retention policy.
- Rotate access tokens and secrets immediately if they are ever committed or shared.
- Webhook bodies are capped at 1 MB by default, and Meta API calls time out after 10 seconds. Both limits are configurable.
- Meta `429` and `5xx` send responses receive bounded retries. A webhook is not acknowledged as successful while delivery still fails. Successful stages are deduplicated before later attempts.

See [SECURITY.md](SECURITY.md) for the supported version and private vulnerability reporting process.

## Operating Boundary

This release is designed for one Instagram professional account and one active process using one state directory or Docker volume. It is suitable for an individual or small team running a low-volume CTA funnel. It is not a multi-tenant SaaS, a high-availability cluster, or a managed backup service.

Do not run multiple replicas against the same account and separate state stores. Duplicate protection is serialized inside one process and persisted to its local state.

## Meta Messaging Limits

Meta currently allows one private reply to a comment within seven days. Additional messages require a user response and must stay inside the messaging window. The kit asks for confirmation before sending the final guide and keeps background follow delivery disabled by default.

Review Meta's current rules before deploying because permissions and messaging limits can change:

- [Instagram API collection by Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Private Replies by Meta](https://www.postman.com/meta/instagram/request/23987686-189d7215-22b3-403f-b2f5-a46c7e66a514)
- [Messaging webhooks by Meta](https://www.postman.com/meta/instagram/request/23987686-95cce6f6-b811-41dc-b560-d43741c5002a)

## Agent Skill

The repository includes `skills/instagram-cta/SKILL.md`. An agent can initialize the project, add routes, validate configuration, and verify health. The runtime still needs to stay online after the agent finishes.

## License

MIT
