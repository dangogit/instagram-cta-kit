# Direct Meta setup

Use this path only when you already have a Meta app or need to own the Meta configuration. New students should start with [HookMyApp](hookmyapp-setup.md).

This project uses the official Instagram API with Instagram Login. It does not automate the Instagram website or use private endpoints.

## 1. Prepare the account

- Use an Instagram Business or Creator account.
- Make sure the person configuring the app can manage that account.

## 2. Create the Meta app

- Create a Meta app suitable for business use.
- Add Instagram API with Instagram Login.
- Add the professional account as an app role or test account during development.

Standard Access covers professional accounts you own or manage and have added to the app. Serving accounts you do not own or manage requires Advanced Access and App Review.

## 3. Add permissions and credentials

Authorize:

- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

Initialize:

```bash
instagram-cta init --dir ./my-instagram-cta --provider meta --locale en
```

Put these values in `.env`:

```text
META_APP_SECRET
IG_USER_ID
IG_ACCESS_TOKEN
```

Do not paste credentials into issues, screenshots, recordings, or route files.

## 4. Pick a runtime mode

Polling needs no public URL, but the computer must stay online:

```bash
instagram-cta init --dir ./my-instagram-cta --provider meta --mode polling
```

Webhooks are real time. Expose the service through public HTTPS and configure:

- Callback URL: `https://your-domain.example/webhook`
- Verify token: the exact `VERIFY_TOKEN` value from `.env`
- Subscriptions: `comments`, `messages`, and `messaging_postbacks`

The service verifies `X-Hub-Signature-256` with `META_APP_SECRET`.

## 5. Verify before live delivery

Keep `DRY_RUN=1`:

```bash
instagram-cta doctor --dir ./my-instagram-cta --live
instagram-cta routes validate --dir ./my-instagram-cta --check-guides
instagram-cta start --dir ./my-instagram-cta
instagram-cta status --dir ./my-instagram-cta
```

Then set `DRY_RUN=0`, restart, and test one account and one keyword.

Confirm the public reply, opt-in DM, user confirmation, final guide, and empty recovery queue. A successful webhook alone is not delivery proof.

## Current Meta references

- [Instagram API with Instagram Login](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
- [Private Replies](https://www.postman.com/meta/instagram/request/23987686-189d7215-22b3-403f-b2f5-a46c7e66a514)
- [Quick Replies](https://www.postman.com/meta/instagram/request/23987686-df99e677-3390-449c-a016-8e94dd09ec77)
- [Messaging Webhook](https://www.postman.com/meta/instagram/request/23987686-95cce6f6-b811-41dc-b560-d43741c5002a)
