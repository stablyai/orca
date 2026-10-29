import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from './delegated-mobile-device-contract'

// Send executionHost only after capability negotiation: older desktops ignore it and would execute locally.
export const MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY = 'mobile.desktop-relay.v1' as const

// The desktop answers server-row snapshots and row deltas, as worktree.ps does for its own rows.
export const MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY =
  'mobile.relay-host-worktree-deltas.v1' as const

// Paired desktop/web clients may send executionHost only when this is advertised; older servers run it locally.
// Conditional: only a server wired to its managed hosts can relay, so it is not in RUNTIME_CAPABILITIES.
export const RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY = 'runtime.client-relay.v1' as const

// Relayed terminal.multiplex needs both sides: the server advertises it and the client declares it at auth.
// Without the client's declaration the relay keeps refusing terminal.multiplex, as runtime.client-relay.v1 promised.
export const RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY =
  'runtime.client-relay.terminal-multiplex.v1' as const

/** Stamped per connection wherever the server relays runtime clients. */
export const RUNTIME_CLIENT_RELAY_CONNECTION_CAPABILITIES = [
  RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY
] as const

/** A desktop relays a phone to a server that mints delegated phone devices; each side advertises. */
export const MOBILE_RELAY_RUNTIME_CAPABILITIES = [
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY
] as const
