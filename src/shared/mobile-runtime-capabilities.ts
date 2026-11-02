import { NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY } from './desktop-client-presence'
import { MOBILE_RELAY_RUNTIME_CAPABILITIES } from './mobile-desktop-relay-contract'

// Hosts without this capability have no notifications.registerPush RPC.
export const NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY = 'notifications.remote-push.v1' as const

// Hosts without this capability refuse phone repo.add/repo.create/repo.clone, so mobile hides Add project.
export const MOBILE_ADD_PROJECT_RUNTIME_CAPABILITY = 'mobile.add-project.v1' as const

export const MOBILE_RUNTIME_CAPABILITIES = [
  'mobile.tasks.v1',
  MOBILE_ADD_PROJECT_RUNTIME_CAPABILITY,
  NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
  NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY,
  ...MOBILE_RELAY_RUNTIME_CAPABILITIES
] as const
