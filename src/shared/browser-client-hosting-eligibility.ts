import {
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY
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

/** Share main placement and renderer staging prediction to avoid panes stuck connecting. Pairing/graph/lease conditions visible on one side stay there. */
export function expectsBrowserClientHosting(input: {
  enabled: boolean
  preference: BrowserClientHostPlacementPreference | undefined
  deviceScope: string | null | undefined
  capabilities: readonly string[] | undefined
}): boolean {
  // Why: a server that cannot stream can't honor the server-render setting; its pages would become unregistered desktop tabs.
  const serverCanStream = input.capabilities?.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY)
  return (
    (input.enabled || !serverCanStream) &&
    (input.preference ?? 'auto') !== 'server' &&
    input.deviceScope !== 'mobile' &&
    runtimeAdvertisesBrowserClientHosting(input.capabilities)
  )
}
