import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from '../browser-slice-contract'
import type { BrowserCookieImportResult } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import type { BrowserDetectProfilesResult } from '../../../../../../shared/browser/runtime/runtime-browser-contracts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import {
  getBrowserSettingsHostId,
  getBrowserSettingsRuntimeEnvironmentId,
  browserImportStateForHostUpdate,
  retainCookieImportExecutionHost
} from '../hosts/browser-host-state'
import { browserCookieImportFailureText } from '@/lib/browser/cookies/browser-cookie-import-error-copy'
import { importSshPageCookies } from './browser-ssh-page-cookie-import'
import {
  clientHostCookieImportTarget,
  pageCookieImportHostId
} from './browser-page-cookie-import-route'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'

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
    importCookiesToProfile: async (profileId, pageRoute?) => {
      if (pageRoute?.kind === 'ssh') {
        return importSshPageCookies(get, pageRoute, () =>
          window.api.browser.sessionImportCookies({ profileId, sshTargetId: pageRoute.sshTargetId })
        )
      }
      const initialState = get()
      const hostId = pageCookieImportHostId(pageRoute) ?? getBrowserSettingsHostId(initialState)
      const executionHostLabel = selectExecutionHostDisplayLabel(initialState, hostId)
      const parsedHostId = parseExecutionHostId(hostId)
      const runtimeEnvironmentId =
        parsedHostId?.kind === 'runtime' ? parsedHostId.environmentId : null
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
          ? ((await window.api.browser.sessionImportCookiesForClientHost(
              clientHostCookieImportTarget(initialState, runtimeEnvironmentId, profileId, pageRoute)
            )) ?? remoteCookieImportUnavailable())
          : await window.api.browser.sessionImportCookies({
              profileId,
              ...(parsedHostId?.kind === 'ssh' ? { sshTargetId: parsedHostId.targetId } : {})
            })
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
          await get()
            .fetchBrowserSessionProfiles(hostId)
            .catch(() => {})
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
