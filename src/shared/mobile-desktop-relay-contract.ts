import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from './delegated-mobile-device-contract'

// Send executionHost only after capability negotiation: older desktops ignore it and would execute locally.
export const MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY = 'mobile.desktop-relay.v1' as const

/** A desktop relays a phone to a server that mints delegated phone devices; each side advertises. */
export const MOBILE_RELAY_RUNTIME_CAPABILITIES = [
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY
] as const
