import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from './delegated-mobile-device-contract'

// Send executionHost only after capability negotiation: older desktops ignore it and would execute locally.
export const MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY = 'mobile.desktop-relay.v1' as const

// Paired desktop/web clients may send executionHost only when this is advertised; older servers run it locally.
// Conditional: only a server wired to its managed hosts can relay, so it is not in RUNTIME_CAPABILITIES.
export const RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY = 'runtime.client-relay.v1' as const

/** A desktop relays a phone to a server that mints delegated phone devices; each side advertises. */
export const MOBILE_RELAY_RUNTIME_CAPABILITIES = [
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY
] as const
