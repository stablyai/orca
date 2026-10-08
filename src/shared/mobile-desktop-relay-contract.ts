// Why: a phone may put `executionHost` on a request only after its desktop advertises this; an older
// desktop ignores the field and would run the call on itself. Not in RUNTIME_CAPABILITIES yet: the
// phone's host-scoped client ships first (S2), and adding it there is the one line that turns relay on.
export const MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY = 'mobile.desktop-relay.v1' as const
