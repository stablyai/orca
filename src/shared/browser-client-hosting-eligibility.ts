import {
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from './protocol-version'
import type { BrowserClientHostPlacementPreference } from './browser-client-host-placement'

/** Every capability a runtime must advertise before this client can host its browser pages. */
export const BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES = [
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
] as const

export function runtimeAdvertisesBrowserClientHosting(
  capabilities: readonly string[] | undefined
): boolean {
  return BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES.every((capability) =>
    capabilities?.includes(capability)
  )
}

/**
 * Whether a browser page created against this runtime will be hosted by this client.
 *
 * Why it is shared: the main process decides this for real while preparing the placement, and the
 * renderer has to predict the same answer one round-trip earlier to mount the right pane in the
 * staged frame. Two copies drift silently — the renderer would stage a client-hosted pane that
 * never receives a placement, and the user would sit in front of a pane that stays connecting.
 * Conditions only one side can see (pairing, graph readiness, lease startup) stay on that side.
 */
export function expectsBrowserClientHosting(input: {
  enabled: boolean
  preference: BrowserClientHostPlacementPreference | undefined
  deviceScope: string | null | undefined
  capabilities: readonly string[] | undefined
}): boolean {
  return (
    input.enabled &&
    (input.preference ?? 'auto') !== 'server' &&
    input.deviceScope !== 'mobile' &&
    runtimeAdvertisesBrowserClientHosting(input.capabilities)
  )
}
