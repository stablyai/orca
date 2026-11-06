import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import type { BrowserCookieImportResult } from '../../../../../shared/browser-workspace-types'
import type { BrowserDetectProfilesResult } from '../../../../../shared/runtime-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import {
  getBrowserSettingsHostId,
  getBrowserSettingsRuntimeEnvironmentId,
  browserImportStateForHostUpdate,
  retainCookieImportExecutionHost
} from './browser-host-state'
import { browserCookieImportFailureText } from '@/lib/browser-cookie-import-error-copy'

function remoteCookieImportUnavailable(): BrowserCookieImportResult {
  return {
    ok: false,
    reason: translate(
      'auto.store.slices.browser.remoteCookieImportUnavailable',
      'Manual cookie file import is unavailable while a remote runtime is active.'
    )
  }
}

export function createBrowserProfileImportActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<
  BrowserSlice,
  'importCookiesToProfile' | 'clearBrowserSessionImportState' | 'fetchDetectedBrowsers'
> {
  return {
    importCookiesToProfile: async (profileId) => {
      const initialState = get()
      const hostId = getBrowserSettingsHostId(initialState)
      const executionHostLabel = selectExecutionHostDisplayLabel(initialState, hostId)
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(initialState)
      set((state) =>
        browserImportStateForHostUpdate(state, hostId, {
          profileId,
          status: 'importing',
          summary: null,
          error: null
        })
      )
      try {
        // Under a remote runtime, only pages this desktop hosts can take a local cookie file.
        const result: BrowserCookieImportResult = runtimeEnvironmentId
          ? ((await window.api.browser.sessionImportCookiesForClientHost({
              environmentId: runtimeEnvironmentId,
              profileId
            })) ?? remoteCookieImportUnavailable())
          : await window.api.browser.sessionImportCookies({ profileId })
        if (result.ok) {
          get().recordFeatureInteraction?.('cookie-import')
          set((state) =>
            browserImportStateForHostUpdate(state, hostId, {
              profileId,
              status: 'success',
              summary: result.summary,
              error: null
            })
          )
          if (getBrowserSettingsHostId(get()) === hostId) {
            await get()
              .fetchBrowserSessionProfiles()
              .catch(() => {})
          }
        } else {
          set((state) =>
            browserImportStateForHostUpdate(state, hostId, {
              profileId,
              status: result.reason === 'canceled' ? 'idle' : 'error',
              summary: null,
              error: result.reason === 'canceled' ? null : browserCookieImportFailureText(result)
            })
          )
        }
        return retainCookieImportExecutionHost(result, hostId, executionHostLabel, 'client')
      } catch (err) {
        const reason = String((err as Error)?.message ?? err)
        set((state) =>
          browserImportStateForHostUpdate(state, hostId, {
            profileId,
            status: 'error',
            summary: null,
            error: reason
          })
        )
        return retainCookieImportExecutionHost(
          { ok: false as const, reason },
          hostId,
          executionHostLabel,
          'client'
        )
      }
    },

    clearBrowserSessionImportState: () => {
      set({ browserSessionImportState: null })
    },

    fetchDetectedBrowsers: async () => {
      const hostId = getBrowserSettingsHostId(get())
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
      if (runtimeEnvironmentId) {
        const hostLabel = selectExecutionHostDisplayLabel(get(), hostId)
        try {
          // Import reads the page-hosting machine’s browsers: client-hosted means desktop, not headless remote.
          const clientHostBrowsers = await window.api.browser.sessionDetectBrowsersForClientHost({
            environmentId: runtimeEnvironmentId
          })
          const browsers =
            clientHostBrowsers ??
            (
              await callRuntimeRpc<BrowserDetectProfilesResult>(
                { kind: 'environment', environmentId: runtimeEnvironmentId },
                'browser.profileDetectBrowsers',
                undefined,
                { timeoutMs: 15_000 }
              )
            ).browsers
          // Why: retain which machine answered so import menus can say where imports read and store.
          const detectedBrowsersHost = {
            machine: clientHostBrowsers ? ('client' as const) : ('remote' as const),
            hostLabel
          }
          set((s) =>
            getBrowserSettingsHostId(s) === hostId
              ? { detectedBrowsers: browsers, detectedBrowsersLoaded: true, detectedBrowsersHost }
              : s
          )
        } catch {
          set((s) =>
            getBrowserSettingsHostId(s) === hostId
              ? { detectedBrowsers: [], detectedBrowsersLoaded: true, detectedBrowsersHost: null }
              : s
          )
        }
        return
      }
      if (get().detectedBrowsersLoaded) {
        return
      }
      try {
        const browsers = (await window.api.browser.sessionDetectBrowsers()) as {
          family: string
          label: string
          profiles: { name: string; directory: string }[]
          selectedProfile: string
        }[]
        set((s) =>
          getBrowserSettingsHostId(s) === hostId
            ? {
                detectedBrowsers: browsers,
                detectedBrowsersLoaded: true,
                detectedBrowsersHost: null
              }
            : s
        )
      } catch {
        /* best-effort — empty list is acceptable fallback */
        set((s) => (getBrowserSettingsHostId(s) === hostId ? { detectedBrowsersLoaded: true } : s))
      }
    }
  }
}
