import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import type { BrowserCookieImportResult } from '../../../../../shared/browser-workspace-types'
import type {
  BrowserProfileImportFromBrowserResult,
  BrowserProfileClearDefaultCookiesResult
} from '../../../../../shared/runtime-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import {
  getBrowserSettingsHostId,
  getBrowserSettingsRuntimeEnvironmentId,
  browserImportStateForHostUpdate,
  retainCookieImportExecutionHost
} from './browser-host-state'

export function createBrowserCookieImportActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'importCookiesFromBrowser' | 'clearDefaultSessionCookies'> {
  return {
    importCookiesFromBrowser: async (profileId, browserFamily, browserProfile?) => {
      const initialState = get()
      const hostId = getBrowserSettingsHostId(initialState)
      const executionHostLabel = selectExecutionHostDisplayLabel(initialState, hostId)
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(initialState)
      if (runtimeEnvironmentId) {
        set((state) =>
          browserImportStateForHostUpdate(state, hostId, {
            profileId,
            status: 'importing',
            summary: null,
            error: null
          })
        )
        // Why: tracked across the try so a failed fallback RPC still reports the machine it ran on.
        let ranOnClient = false
        try {
          // Why: client-hosted pages render on this desktop, so their logins live
          // here -- detecting and importing on the headless remote finds nothing.
          const clientHostResult = await window.api.browser.sessionImportFromBrowserForClientHost({
            environmentId: runtimeEnvironmentId,
            profileId,
            browserFamily,
            browserProfile
          })
          ranOnClient = clientHostResult != null
          const result =
            clientHostResult ??
            (await callRuntimeRpc<BrowserProfileImportFromBrowserResult>(
              { kind: 'environment', environmentId: runtimeEnvironmentId },
              'browser.profileImportFromBrowser',
              { profileId, browserFamily, browserProfile, supportsPartitionSkippedCookies: true },
              { timeoutMs: 30_000 }
            ))
          if (result.ok) {
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
                status: 'error',
                summary: null,
                error: result.reason
              })
            )
          }
          return retainCookieImportExecutionHost(
            result,
            hostId,
            executionHostLabel,
            ranOnClient ? 'client' : 'remote'
          )
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
            ranOnClient ? 'client' : 'remote'
          )
        }
      }
      set((state) =>
        browserImportStateForHostUpdate(state, hostId, {
          profileId,
          status: 'importing',
          summary: null,
          error: null
        })
      )
      try {
        const result = (await window.api.browser.sessionImportFromBrowser({
          profileId,
          browserFamily,
          browserProfile
        })) as BrowserCookieImportResult
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
              status: 'error',
              summary: null,
              error: result.reason
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

    clearDefaultSessionCookies: async () => {
      const hostId = getBrowserSettingsHostId(get())
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
      if (runtimeEnvironmentId) {
        try {
          const result = await callRuntimeRpc<BrowserProfileClearDefaultCookiesResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'browser.profileClearDefaultCookies',
            undefined,
            { timeoutMs: 15_000 }
          )
          if (result.cleared && getBrowserSettingsHostId(get()) === hostId) {
            await get().fetchBrowserSessionProfiles()
          }
          return result.cleared
        } catch {
          return false
        }
      }
      try {
        const ok = await window.api.browser.sessionClearDefaultCookies()
        if (ok && getBrowserSettingsHostId(get()) === hostId) {
          get().recordFeatureInteraction?.('cookie-import')
          await get().fetchBrowserSessionProfiles()
        }
        return ok
      } catch {
        return false
      }
    }
  }
}
