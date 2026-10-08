// Why: a phone may put `executionHost` on a request only after its desktop advertises this; an older
// desktop ignores the field and would run the call on itself.
export const MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY = 'mobile.desktop-relay.v1' as const

// Why: a phone composes a server workspace's strip with the desktop's own tabs (`desktopTabOrder`)
// and opens editor tabs there through the desktop only after its desktop advertises this.
export const MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY = 'mobile.desktop-owned-tabs.v1' as const

/** A desktop relays a phone to a server that mints delegated phone devices; each side advertises. */
export const MOBILE_RELAY_RUNTIME_CAPABILITIES = [
  'pairing.delegated-mobile-devices.v1',
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
  MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY
] as const
