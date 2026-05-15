// Why: declares the Orca runtime RPC compatibility contract. Desktop,
// headless server, CLI, and mobile builds may drift in app version, but
// they must agree on this protocol range before runtime RPCs are allowed.
//
// Bump RUNTIME_PROTOCOL_VERSION when:
//   - You remove an RPC method or required parameter that clients use.
//   - You change the meaning (units, nullability) of an existing field
//     clients read.
//   - You change encrypted framing, terminal stream framing, or auth.
// Do NOT bump for:
//   - Adding new RPC methods.
//   - Adding new optional fields on existing methods.
//   - Adding new ignorable event types.
//
// Bump MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION when a runtime server must
// refuse older clients. Bump MIN_COMPATIBLE_RUNTIME_SERVER_VERSION when
// this client build requires a newer server. Exact app-version equality is
// never required; these numbers define the supported compatibility window.

export const RUNTIME_PROTOCOL_VERSION = 2
export const MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION = 2
export const MIN_COMPATIBLE_RUNTIME_SERVER_VERSION = 2

export const RUNTIME_CAPABILITIES = [
  'runtime.status.compat.v1',
  'runtime.environments.v1',
  'terminal.binary-stream.v1',
  'terminal.multiplex.v1'
] as const

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number] | (string & {})

// COMPAT(mobileProtocolAliases): added 2026-05-15 for mobile builds that
// still read desktop/mobile names; remove once mobile reads runtime names.
export const DESKTOP_PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION
export const MIN_COMPATIBLE_MOBILE_VERSION = MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
