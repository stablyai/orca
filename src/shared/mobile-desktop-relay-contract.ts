import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from './delegated-mobile-device-contract'

// Send executionHost only after capability negotiation: older desktops ignore it and would execute locally.
export const MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY = 'mobile.desktop-relay.v1' as const

// The desktop answers server-row snapshots and row deltas, as worktree.ps does for its own rows.
export const MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY =
  'mobile.relay-host-worktree-deltas.v1' as const

/** A desktop relays a phone to a server that mints delegated phone devices; each side advertises. */
export const MOBILE_RELAY_RUNTIME_CAPABILITIES = [
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY
] as const
