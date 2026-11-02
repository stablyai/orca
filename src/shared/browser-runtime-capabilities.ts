export const BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY = 'browser.google-cookie-clear.v1' as const
// Advertise only with an available offscreen backend so remote-owned pages cannot fall back to local desktop tabs.
export const BROWSER_HEADLESS_RUNTIME_CAPABILITY = 'browser.headless.v1' as const
export const BROWSER_IDENTITY_RUNTIME_CAPABILITY = 'browser.identity.v1' as const
export const BROWSER_SCREENCAST_RUNTIME_CAPABILITY = 'browser.screencast.v1' as const
export const BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY = 'browser.certificate-trust.v1' as const
// Older hosts drop tabCreate.page; trust preallocated IDs only when advertised.
export const BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY =
  'browser.tab-create-known-id.v1' as const
export const BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY = 'browser.clientHost.v1' as const
export const BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY =
  'browser.clientHost.pageMetadata.v1' as const
export const BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY =
  'browser.clientHost.automation.v1' as const
// Why: without it a client-placed browser.upload would resolve remote paths on the desktop filesystem, so uploads fail closed instead.
export const BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY =
  'browser.clientHost.fileChannel.v1' as const
export const BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY = 'network.browserTunnel.v1' as const
export const BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY =
  'network.browserTunnel.executionHosts.v1' as const

// Headless, identity and certificate trust are host-conditional, so getStatus adds them itself.
export const BROWSER_RUNTIME_CAPABILITIES = [
  BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
] as const
