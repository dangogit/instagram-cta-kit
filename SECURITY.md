# Security Policy

## Supported Versions

Security fixes are applied to the latest `0.1.x` release.

## Reporting a Vulnerability

Use [GitHub private vulnerability reporting](https://github.com/dangogit/instagram-cta-kit/security/advisories/new). Do not include access tokens, app secrets, webhook payloads, or Instagram user identifiers in a public issue.

If a credential may have been exposed, revoke or rotate it in Meta immediately. Removing a credential from Git history does not make it safe to reuse.

## Deployment Boundary

This project is a single-account, single-process self-hosted service. It is not a multi-tenant SaaS and does not provide user authentication, encrypted storage, high availability, or a managed backup system.

Bind the service to localhost unless a TLS reverse proxy or tunnel is required for Meta webhooks. Protect `.env`, the Docker state volume, and local backups. Prevent untrusted users from modifying `routes.json`.
