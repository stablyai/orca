import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from '../browser-slice-contract'
import type {
  BrowserProfileImportFromBrowserResult,
  BrowserProfileClearDefaultCookiesResult
} from '../../../../../../shared/browser/runtime/runtime-browser-contracts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import {
  getBrowserSettingsHostId,
  getBrowserSettingsRuntimeEnvironmentId,
  browserImportStateForHostUpdate,
  retainCookieImportExecutionHost
} from '../hosts/browser-host-state'
import { browserCookieImportFailureText } from '@/lib/browser/cookies/browser-cookie-import-error-copy'
import { importSshPageCookies } from './browser-ssh-page-cookie-import'

export function createBrowserCookieImportActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'importCookiesFromBrowser' | 'clearDefaultSessionCookies'> {
  return {
    importCookiesFromBrowser: async (profileId, source, browserProfile?, sshRoute?) => {
      const selection =
        typeof source === 'string'
          ? { browserFamily: source, browserProfile }
          : { refreshSourceId: source.refreshSourceId }
      if (sshRoute) {
        return importSshPageCookies(get, sshRoute, () =>
          window.api.browser.sessionImportFromBrowser({
            profileId,
            ...selection,
            sshTargetId: sshRoute.sshTargetId
          })
        )
      }
      const initialState = get()
      const hostId =
        typeof source === 'string' ? getBrowserSettingsHostId(initialState) : source.hostId
      const executionHostLabel = selectExecutionHostDisplayLabel(initialState, hostId)
      const target = parseExecutionHostId(hostId)
      const runtimeEnvironmentId = target?.kind === 'runtime' ? target.environmentId : null
      const refreshProfiles = async (): Promise<void> => {
        if (typeof source !== 'string' || getBrowserSettingsHostId(get()) === hostId) {
          await get()
            .fetchBrowserSessionProfiles(hostId)
            .catch(() => {})
        }
      }
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
          // Client-hosted pages use desktop login jars; headless remote detection/import finds nothing.
          const clientHostResult = await window.api.browser.sessionImportFromBrowserForClientHost({
            environmentId: runtimeEnvironmentId,
            profileId,
            ...selection
          })
          ranOnClient = clientHostResult != null
          const pairingRevision = captureRuntimeEnvironmentRequestRevision(runtimeEnvironmentId)
          const result: BrowserProfileImportFromBrowserResult =
            clientHostResult ??
            (await callRuntimeRpc<BrowserProfileImportFromBrowserResult>(
              { kind: 'environment', environmentId: runtimeEnvironmentId },
              'browser.profileImportFromBrowser',
              { profileId, ...selection, supportsPartitionSkippedCookies: true },
              { timeoutMs: 30_000, expectedEnvironmentPairingRevision: pairingRevision }
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
            await refreshProfiles()
          } else {
            set((state) =>
              browserImportStateForHostUpdate(state, hostId, {
                profileId,
                status: 'error',
                summary: null,
                error: browserCookieImportFailureText(result)
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
        const result = await window.api.browser.sessionImportFromBrowser({
          profileId,
          ...selection
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
          await refreshProfiles()
        } else {
          set((state) =>
            browserImportStateForHostUpdate(state, hostId, {
              profileId,
              status: 'error',
              summary: null,
              error: browserCookieImportFailureText(result)
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
