import { NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY } from './desktop-client-presence'
import { MOBILE_RELAY_RUNTIME_CAPABILITIES } from './mobile-desktop-relay-contract'

// Hosts without this capability have no notifications.registerPush RPC.
export const NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY = 'notifications.remote-push.v1' as const

export const NOTIFICATIONS_PUSH_ROUTE_KEY_RUNTIME_CAPABILITY =
  'notifications.push-route-key.v1' as const

export const MOBILE_RUNTIME_CAPABILITIES = [
  'mobile.tasks.v1',
  NOTIFICATIONS_PUSH_ROUTE_KEY_RUNTIME_CAPABILITY,
  NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
  NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY,
  ...MOBILE_RELAY_RUNTIME_CAPABILITIES
] as const
