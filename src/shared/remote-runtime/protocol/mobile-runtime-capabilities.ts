import { NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY } from '../../app-lifecycle/presence/desktop-client-presence'
import { MOBILE_RELAY_RUNTIME_CAPABILITIES } from '../relay/mobile-desktop-relay-contract'

// Hosts without this capability have no notifications.registerPush RPC.
export const NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY = 'notifications.remote-push.v1' as const

// Hosts without this capability have no notifications.pushCoverage RPC, so a mirroring desktop pushes its phones itself.
export const NOTIFICATIONS_PUSH_COVERAGE_RUNTIME_CAPABILITY =
  'notifications.push-coverage.v1' as const

export const MOBILE_RUNTIME_CAPABILITIES = [
  'mobile.tasks.v1',
  NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
  NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY,
  NOTIFICATIONS_PUSH_COVERAGE_RUNTIME_CAPABILITY,
  ...MOBILE_RELAY_RUNTIME_CAPABILITIES
] as const
