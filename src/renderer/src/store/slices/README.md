# Application state slices

Owns renderer state transitions and snapshots used by workspace persistence.

Agent-status modules capture terminal launch settings for sleeping sessions and cold restore. Shared resume contracts live in [shared](../../../../shared/README.md); launch orchestration belongs to [renderer libraries](../../lib/README.md).
