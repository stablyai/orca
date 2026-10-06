# Renderer runtime clients

Routes renderer operations to local or paired execution hosts.

- `runtime-client-target.ts`: owner and target selection.
- `runtime-rpc-client.ts`: RPC dispatch and compatibility caching.
- `runtime-rpc-call-options.ts`: dispatch, cancellation and pairing revision options.
- `runtime-rpc-environment-call.ts`: paired-host transport.
- Session and terminal clients translate UI operations into host-owned requests.

Shared RPC envelopes and protocol contracts live in `../../../shared`.
