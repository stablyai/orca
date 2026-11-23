export const BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY = 'browser.google-cookie-clear.v1' as const
// Advertise only with an available offscreen backend so remote-owned pages cannot fall back to local desktop tabs.
export const BROWSER_HEADLESS_RUNTIME_CAPABILITY = 'browser.headless.v1' as const
export const BROWSER_IDENTITY_RUNTIME_CAPABILITY = 'browser.identity.v1' as const
export const BROWSER_SCREENCAST_RUNTIME_CAPABILITY = 'browser.screencast.v1' as const
export const BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY = 'browser.certificate-trust.v1' as const
// The element picker for streamed pages; only hosts that render pages can run it.
export const BROWSER_GRAB_RUNTIME_CAPABILITY = 'browser.grab.v1' as const
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
// Older hosts' browser.tabSetProfile can't switch a client-hosted page, so desktops hide its Profile submenu without this.
export const BROWSER_CLIENT_PROFILE_SWITCH_RUNTIME_CAPABILITY =
  'browser.clientHost.profileSwitch.v1' as const
export const BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY = 'network.browserTunnel.v1' as const
export const BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY =
  'network.browserTunnel.executionHosts.v1' as const
// Larger stream windows bounded by connection-level credit; the host echoes it on ready to opt in.
export const BROWSER_NETWORK_TUNNEL_WINDOW_V2_CAPABILITY =
  'network.browserTunnel.window.v2' as const

// Older hosts drop expectUrl and would act unguarded, so the CLI refuses the flag without this.
export const BROWSER_EXPECT_URL_RUNTIME_CAPABILITY = 'browser.expect-url.v1' as const

// Older hosts publish server tabs with canGoBack/canGoForward hardcoded false, so clients keep both arrows enabled without this.
export const BROWSER_TAB_HISTORY_STATE_RUNTIME_CAPABILITY = 'browser.tab-history-state.v1' as const

// Older hosts have no browser.zoom, so streamed panes keep zoom chords on Orca's own zoom.
export const BROWSER_PAGE_ZOOM_RUNTIME_CAPABILITY = 'browser.page-zoom.v1' as const

// Older hosts have no browser.siteDisplay or browser.setSiteColorScheme, so streamed panes hide the zoom row, zoom chip and Appearance.
export const BROWSER_SITE_DISPLAY_RUNTIME_CAPABILITY = 'browser.site-display.v1' as const

// Older hosts have no browser.stop and drop browser.reload's ignoreCache, so streamed panes offer only plain reload.
export const BROWSER_STOP_HARD_RELOAD_RUNTIME_CAPABILITY = 'browser.stop-hard-reload.v1' as const

// Older hosts have no browser.findInPage, so streamed panes answer Cmd+F with a notice instead of the find bar.
export const BROWSER_FIND_IN_PAGE_RUNTIME_CAPABILITY = 'browser.find-in-page.v1' as const

// Headless hosts that rebuild a page in place for browser.tabSetProfile; streamed panes show ⋯ › Profile only with this.
export const BROWSER_TAB_PROFILE_SWITCH_RUNTIME_CAPABILITY =
  'browser.tab-profile-switch.v1' as const

// Older hosts publish no audible state and have no browser.setAudioMuted, so streamed tabs never show the speaker.
export const BROWSER_AUDIO_MUTE_RUNTIME_CAPABILITY = 'browser.audio-mute.v1' as const

// Headless, identity, certificate trust, page zoom, site display, stop/hard reload, find in page, profile switch and audio mute are host-conditional, so getStatus adds them itself.
export const BROWSER_RUNTIME_CAPABILITIES = [
  BROWSER_EXPECT_URL_RUNTIME_CAPABILITY,
  BROWSER_TAB_HISTORY_STATE_RUNTIME_CAPABILITY,
  BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PROFILE_SWITCH_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
] as const
