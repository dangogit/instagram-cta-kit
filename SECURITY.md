# Security Policy

## Supported Versions

Security fixes are applied to the latest `0.2.x` release.

## Reporting a Vulnerability

Use [GitHub private vulnerability reporting](https://github.com/dangogit/instagram-cta-kit/security/advisories/new). Do not include access tokens, app secrets, webhook payloads, or Instagram user identifiers in a public issue.

If a credential may have been exposed, revoke or rotate it in HookMyApp or Meta immediately. Removing a credential from Git history does not make it safe to reuse.

## Deployment Boundary

This project is a single-account, single-process self-hosted service. It is not a multi-tenant SaaS and does not provide user authentication, encrypted storage, high availability, or a managed backup system.

Bind the service to localhost unless a TLS reverse proxy or tunnel is required for webhooks. Protect `.env`, `CTA_ADMIN_TOKEN`, the Docker state volume, and local backups. Prevent untrusted users from modifying `routes.json`.

The runtime refuses a non-loopback HTTP bind unless `ALLOW_INSECURE_HTTP=1` is set. That flag is an acknowledgement that HTTPS terminates at a trusted proxy or tunnel. It does not add encryption by itself.

The admin endpoints can retry or resolve failed deliveries. They require `CTA_ADMIN_TOKEN`. Do not expose them without an authenticated reverse proxy.

Webhook payloads are normalized before they enter the durable queue. Pending, processing, and dead-letter records still contain the comment or DM text needed for replay, quick-reply payloads, Instagram-scoped identifiers, and Story IDs or URLs when present. Completed records keep only delivery metadata. Resolving a dead letter replaces its replayable payload with a sanitized resolution record.

Treat the full state directory and backups as private data. Resolve dead letters after investigation and delete backups according to your retention policy.
