# Shared contracts

Defines data and pure logic shared across desktop, runtime and renderer boundaries.

- `agent-session-record.ts`, `agent-session-account-home.ts`: durable conversations, registered-agent account homes and validated profile ownership.
- `agent-launch-profile.ts`: host-owned Claude/Codex bindings, normalization and session snapshot contracts.
- `agent-launch-profile-name.ts`: shared profile name validation.
- `agent-profile-connection.ts`, `agent-profile-capabilities.ts`: public management DTOs and supported profile actions.
- `agent-session-resume.ts`, `tui-agent-startup.ts`: terminal startup and recovery contracts.
- `global-settings-types.ts`: persisted settings schema.
- `rpc-contract/structured-agent-session-envelope-params.ts`: shared RPC identity, cursor and mutation fence schemas.

Credential storage and enrollment belong to [Claude accounts](../main/claude-accounts/README.md).

`agent-launch-profile.ts` validates profile snapshots; `sleeping-agent-launch-config-types.ts` and
`sleeping-agent-launch-config.ts` define and copy durable launch bindings. `terminal-profile-routing.ts`
refuses local-only bindings before transport to paired runtimes.
