# 0001 - Single Process Runtime and Local State

**Status:** accepted
**Date:** 2026-07-15
**Spec:** README and SECURITY.md
**Deciders:** repository maintainers

## Context

The kit is intended for one Instagram professional account operated by an individual or small team. It needs a simple installation path on a personal computer or small server without a database dependency.

## Decision

Use a deterministic Node.js process with signed webhooks, a polling fallback, and a provider adapter selected by environment variables. HookMyApp and direct Meta feed the same route and delivery logic.

Write normalized inbound events to an atomic file queue before acknowledging the webhook. A single recovery worker claims each event, retries transient failures with backoff, restores interrupted claims after a crash, and moves exhausted or permanent failures to a dead-letter directory. Funnel events remain in append-only JSONL.

Docker uses a named state volume, a non-root user, a read-only root filesystem, and a localhost port binding.

## Consequences

The runtime is easy to inspect and self-host. An accepted webhook survives a process crash. The dead-letter queue makes incomplete delivery visible.

It is not horizontally scalable, multi-tenant, or highly available. Operators must protect and back up local state, keep one active process per state volume, and use an external TLS endpoint for webhooks.

## Alternatives Considered

- A hosted multi-tenant service, rejected for this release because it requires account isolation, authentication, billing, and a managed database.
- An external queue and database, deferred until deployments need higher throughput or multiple replicas.
