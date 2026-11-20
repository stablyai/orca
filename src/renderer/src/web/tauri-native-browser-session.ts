import type { PreloadApi } from '../../../preload/api-types'
import type {
  BrowserCookieImportResult,
  BrowserSessionProfile
} from '../../../shared/browser/workspaces/browser-workspace-types'
import type { DetectedBrowserInfo } from '../../../preload/api/browser/browser-api'
import type {
  BrowserIdentityModeSetResult,
  BrowserIdentityModeStatus,
  BrowserUserAgentMode
} from '../../../shared/browser/identity/browser-user-agent-mode'
import { invokeNative } from './tauri-native-host'
import { getTauriBrowserClientRouteIdentity } from './tauri-native-browser-client-host'
import {
  asClientRouteSourceFamily,
  readTauriClientRouteImportSources,
  recordTauriClientRouteImportSource,
  sanitizeClientRouteSources
} from './tauri-native-browser-client-route-sources'

export function createTauriNativeBrowserSessionApi(): Partial<PreloadApi['browser']> {
  return {
    identityGet: () => invokeNative<BrowserIdentityModeStatus>('poc_browser_identity_get'),
    identitySet: (mode: BrowserUserAgentMode) =>
      invokeNative<BrowserIdentityModeSetResult>('poc_browser_identity_set', {
        args: { mode }
      }),
    sessionListProfiles: () =>
      invokeNative<BrowserSessionProfile[]>('poc_browser_session_list_profiles'),
    sessionCreateProfile: ({ scope, label }) =>
      invokeNative<BrowserSessionProfile | null>('poc_browser_session_create_profile', {
        args: { scope, label }
      }),
    sessionDeleteProfile: ({ profileId }) =>
      invokeNative<boolean>('poc_browser_session_delete_profile', {
        args: { profileId }
      }),
    sessionImportCookies: ({ profileId }) =>
      invokeNative<BrowserCookieImportResult>('poc_browser_session_import_cookies', {
        args: { profileId }
      }),
    sessionImportFromBrowser: ({ profileId, browserFamily, browserProfile }) =>
      invokeNative<BrowserCookieImportResult>('poc_browser_session_import_from_browser', {
        args: { profileId, browserFamily, browserProfile }
      }),
    sessionClearDefaultCookies: () =>
      invokeNative<boolean>('poc_browser_session_clear_default_cookies'),
    sessionResolvePartition: ({ profileId }) =>
      invokeNative<string>('poc_browser_session_resolve_partition', {
        args: { profileId }
      }),
    sessionDetectBrowsers: () =>
      invokeNative<DetectedBrowserInfo[]>('poc_browser_session_detect_browsers'),
    // Null when this desktop is not hosting the environment, mirroring Electron:
    // the picker must list the machine the import will read from, never the
    // (usually headless) remote.
    sessionDetectBrowsersForClientHost: ({ environmentId }) => {
      if (!getTauriBrowserClientRouteIdentity(environmentId)) {
        return Promise.resolve(null)
      }
      return invokeNative<DetectedBrowserInfo[]>('poc_browser_session_detect_browsers')
    },
    // Client-hosted pages render on this desktop, so their logins are imported
    // here into the environment's client-route jar, never on the remote.
    sessionImportFromBrowserForClientHost: async ({
      environmentId,
      profileId,
      browserFamily,
      browserProfile
    }) => {
      const identity = getTauriBrowserClientRouteIdentity(environmentId)
      if (!identity) {
        return null
      }
      const executionHostKey = identity.executionHostKey
      const result = await invokeNative<BrowserCookieImportResult & { profileName?: string }>(
        'poc_browser_client_route_import_from_browser',
        { args: { environmentId, profileId, executionHostKey, browserFamily, browserProfile } }
      )
      if (!result?.ok) {
        return result
      }
      // Why: the import runs for seconds. A host replacement inside that window
      // retargets the route, so reporting success here would badge a partition
      // no page will ever read from.
      const settled = getTauriBrowserClientRouteIdentity(environmentId)
      if (!settled) {
        return {
          ok: false,
          reason: 'The connection to this server ended during the import. Reconnect and try again.'
        }
      }
      if (settled.executionHostKey !== executionHostKey) {
        return { ok: false, reason: 'This server was re-paired during the import. Try again.' }
      }
      {
        const sourceFamily = asClientRouteSourceFamily(browserFamily)
        if (sourceFamily) {
          const importedProfileName = result.profileName || browserProfile || undefined
          const source = {
            browserFamily: sourceFamily,
            ...(importedProfileName ? { profileName: importedProfileName } : {}),
            importedAt: Date.now()
          }
          recordTauriClientRouteImportSource(environmentId, profileId, source)
          void invokeNative<boolean>('poc_browser_client_route_record_source', {
            args: { environmentId, profileId, source }
          }).catch(() => {})
        }
      }
      return result
    },
    // The server's profile records can't know what this desktop imported into
    // its client-hosted jars; the settings view overlays these onto the list.
    // Host-owned Rust store first, renderer localStorage fallback for older builds.
    sessionClientRouteImportSources: async ({ environmentId }) => {
      try {
        const native = await invokeNative<unknown>('poc_browser_client_route_list_sources', {
          args: { environmentId }
        })
        const sanitized = sanitizeClientRouteSources(native)
        if (native && typeof native === 'object') {
          return sanitized
        }
      } catch {
        // Fall through to the renderer cache below.
      }
      return readTauriClientRouteImportSources(environmentId)
    }
  }
}
