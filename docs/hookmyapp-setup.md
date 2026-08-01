# HookMyApp setup

HookMyApp connects an Instagram professional account through Meta OAuth and gives this kit an official Instagram API transport. You do not create a Meta app for this path.

You will use two CLIs:

- `hookmyapp` manages the Instagram connection, credentials, webhook, and delivery logs.
- `instagram-cta` manages keywords, replies, local recovery, and health.

## 1. Install and connect

```bash
npm install -g @gethookmyapp/cli
npm install -g github:dangogit/instagram-cta-kit

hookmyapp login
hookmyapp channels connect instagram
hookmyapp channels list
```

The connect command opens Meta OAuth. Select the professional Instagram account that should run the CTA.

## 2. Create the CTA directory

```bash
instagram-cta init --dir ./my-instagram-cta --provider hookmyapp --locale en
```

Use `--locale he` for Hebrew default replies.

## 3. Add channel credentials

Replace `ch_YOUR_CHANNEL` with the ID from `hookmyapp channels list`:

```bash
hookmyapp channels env ch_YOUR_CHANNEL --write ./my-instagram-cta/.env
hookmyapp channels webhook hmac show ch_YOUR_CHANNEL
```

The first command writes:

```text
INSTAGRAM_GRAPH_API_URL
INSTAGRAM_ACCESS_TOKEN
INSTAGRAM_ACCOUNT_ID
HOOKMYAPP_CHANNEL_ID
VERIFY_TOKEN
```

The second command prints the signing secret. Save it as `WEBHOOK_HMAC_SECRET` in the same `.env` file. Do not put it in a route file, screenshot, issue, or chat.

## 4. Add and validate a route

Point the route at a guide page you actually publish. A URL on `example.com` is a placeholder, and the guide check skips it instead of testing it.

```bash
instagram-cta route add CHECKLIST https://example.com/checklist \
  --dir ./my-instagram-cta \
  --campaign-id first-checklist

instagram-cta doctor --dir ./my-instagram-cta --live
instagram-cta routes validate --dir ./my-instagram-cta --check-guides
```

`init` also seeds two example routes, `GUIDE` and `מדריך`. They are placeholders on `example.com`, so the guide check reports them as skipped. Remove them once your own keyword works:

```bash
instagram-cta route remove GUIDE --dir ./my-instagram-cta
instagram-cta route remove מדריך --dir ./my-instagram-cta
```

Keep `DRY_RUN=1`.

## 5. Test locally

Start the CTA service:

```bash
instagram-cta start --dir ./my-instagram-cta
```

In a second terminal:

```bash
hookmyapp channels listen ch_YOUR_CHANNEL --port 18787 --path /webhook
```

HookMyApp creates a tunnel and forwards signed events to the local service. Comment the keyword from another account, then inspect:

```bash
instagram-cta status --dir ./my-instagram-cta
hookmyapp channels logs list ch_YOUR_CHANNEL
```

The CTA health output should show:

- `provider: "hookmyapp"`
- `queue.pending_count: 0`
- `queue.dead_letter_count: 0`
- no stale pending event

## 6. Configure a permanent webhook

For a machine with a public HTTPS URL:

```bash
hookmyapp channels webhook set ch_YOUR_CHANNEL \
  --url https://your-domain.example/webhook \
  --verify-token YOUR_VERIFY_TOKEN
hookmyapp channels webhook show ch_YOUR_CHANNEL
hookmyapp channels health ch_YOUR_CHANNEL
```

Replace `YOUR_VERIFY_TOKEN` with the value already stored in `.env`. HookMyApp verifies the endpoint with a GET probe.

The service validates POST requests with `X-HookMyApp-Signature-256` and `WEBHOOK_HMAC_SECRET`. An unsigned production request receives `403`.

## 7. Go live

Set `DRY_RUN=0`, restart the CTA service, and send one controlled comment.

Confirm:

1. The public comment reply appears.
2. The private opt-in DM arrives.
3. The button tap or reply reaches the CTA service.
4. The final guide link arrives.
5. `instagram-cta status` reports no pending event or dead letter.

## Recovery commands

```bash
instagram-cta recover --dir ./my-instagram-cta
instagram-cta dead-letter list --dir ./my-instagram-cta
instagram-cta dead-letter retry EVENT_KEY --dir ./my-instagram-cta
instagram-cta dead-letter resolve EVENT_KEY --reason "provider confirmed permanent" --dir ./my-instagram-cta
```

Use HookMyApp delivery logs to distinguish these cases:

- HookMyApp never delivered the webhook
- the CTA accepted and queued it
- Instagram rejected the outgoing reply

That boundary matters. A successful webhook does not prove the user received a DM.

## Common problems

### Webhook verification fails

- Confirm the public URL ends with `/webhook`.
- Confirm HookMyApp and `.env` use the same verify token.
- Confirm the CTA process is running before setting the webhook.

### Signed POST returns 403

- Run `hookmyapp channels webhook hmac show ch_YOUR_CHANNEL` again.
- Update `WEBHOOK_HMAC_SECRET`.
- Restart the CTA process.

### Comment arrived but no DM

- Run `instagram-cta status`.
- Check `instagram-cta dead-letter list`.
- Check `hookmyapp channels logs list ch_YOUR_CHANNEL`.
- Remember that Instagram can permanently reject a private reply for policy or recipient reasons.

### The local tunnel stopped

`hookmyapp channels listen` is a development tunnel. Restart it, or move the CTA to a server and set a permanent webhook URL.
