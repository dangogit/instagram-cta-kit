# Meta Setup Checklist

This project targets the Instagram API with Instagram Login at `graph.instagram.com`. It does not use browser automation or private Instagram endpoints.

Meta changes its dashboard and review process over time. Use this checklist together with Meta's current documentation.

## 1. Prepare the Instagram Account

- Use an Instagram Business or Creator account.
- Make sure the person configuring the app can manage that account.

## 2. Create the Meta App

- Create a Meta app suitable for business use.
- Add the Instagram API with Instagram Login product.
- Add the Instagram professional account as an app role or test account while developing.

Standard Access is intended for professional accounts you own or manage and have added to the app. Advanced Access and App Review are required when the app will serve professional accounts you do not own or manage.

## 3. Request the Required Permissions

Authorize the Instagram account with:

- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

Generate an Instagram User access token for that professional account. Copy the professional account ID and token into `IG_USER_ID` and `IG_ACCESS_TOKEN` in `.env`. Copy the Meta app secret into `META_APP_SECRET`.

Do not paste credentials into issues, screenshots, terminal recordings, or route files.

## 4. Choose the Runtime Mode

### Polling

Keep `POLL_ENABLED=1`. No public URL is required, but the computer must stay online and awake. Polling uses additional API calls, so webhooks are preferred for sustained production use.

### Webhooks

Keep `POLL_ENABLED=0` and expose the local service through a public HTTPS endpoint. Configure Meta with:

- Callback URL: `https://your-domain.example/webhook`
- Verify token: the exact `VERIFY_TOKEN` value from `.env`
- Subscriptions: `comments`, `messages`, and `messaging_postbacks`

The service rejects unsigned production webhook requests using `X-Hub-Signature-256` and `META_APP_SECRET`.

## 5. Verify Before Sending

Keep `DRY_RUN=1`, then run:

```bash
npx github:dangogit/instagram-cta-kit doctor --dir ./my-instagram-cta --live
npx github:dangogit/instagram-cta-kit routes validate --dir ./my-instagram-cta --check-guides
npx github:dangogit/instagram-cta-kit start --dir ./my-instagram-cta
```

Check `http://127.0.0.1:18787/health`. When the account, route, and webhook tests are correct, set `DRY_RUN=0` and restart.

Test with an account that is authorized for the Meta app. Confirm the private reply, user confirmation, final guide, public reply, and local event entry before announcing the automation.

## Current Meta References

- [Instagram API with Instagram Login](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
- [Private Replies](https://www.postman.com/meta/instagram/request/23987686-189d7215-22b3-403f-b2f5-a46c7e66a514)
- [Quick Replies](https://www.postman.com/meta/instagram/request/23987686-df99e677-3390-449c-a016-8e94dd09ec77)
- [Messaging Webhook](https://www.postman.com/meta/instagram/request/23987686-95cce6f6-b811-41dc-b560-d43741c5002a)

