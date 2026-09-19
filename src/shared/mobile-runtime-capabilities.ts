import { NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY } from './desktop-client-presence'
import { MOBILE_RELAY_RUNTIME_CAPABILITIES } from './mobile-desktop-relay-contract'

// Hosts without this capability have no notifications.registerPush RPC.
export const NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY = 'notifications.remote-push.v1' as const

// Why: repo.add/create/clone were desktop-only RPCs; mobile gates its Add project
// entry on this capability so an older host (no allowlisted methods, required
// destination/parentPath) never receives a call it would reject.
export const REPO_ADD_PROJECT_MOBILE_RUNTIME_CAPABILITY = 'repo.add-project-mobile.v1' as const

export const MOBILE_RUNTIME_CAPABILITIES = [
  'mobile.tasks.v1',
  REPO_ADD_PROJECT_MOBILE_RUNTIME_CAPABILITY,
  NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
  NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY,
  ...MOBILE_RELAY_RUNTIME_CAPABILITIES
] as const
