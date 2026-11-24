import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from '../browser-slice-contract'
import type { BrowserCookieImportResult } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import type { BrowserProfileImportFromBrowserResult } from '../../../../../../shared/browser/runtime/runtime-browser-contracts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import {
  getBrowserSettingsHostId,
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
import { clearPairedServerProfileCookies } from './browser-paired-server-cookie-clear'

export function createBrowserCookieImportActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'importCookiesFromBrowser' | 'clearBrowserProfileCookies'> {
  return {
    importCookiesFromBrowser: async (profileId, browserFamily, browserProfile?, pageRoute?) => {
      if (pageRoute?.kind === 'ssh') {
        return importSshPageCookies(get, pageRoute, () =>
          window.api.browser.sessionImportFromBrowser({
            profileId,
            browserFamily,
            browserProfile,
            sshTargetId: pageRoute.sshTargetId
          })
        )
      }
      const initialState = get()
      const hostId = pageCookieImportHostId(pageRoute) ?? getBrowserSettingsHostId(initialState)
      const executionHostLabel = selectExecutionHostDisplayLabel(initialState, hostId)
      const parsedHostId = parseExecutionHostId(hostId)
      const runtimeEnvironmentId =
        parsedHostId?.kind === 'runtime' ? parsedHostId.environmentId : null
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
          // A page's import never returns null, so it never falls back to the server's own store.
          const clientHostResult = await window.api.browser.sessionImportFromBrowserForClientHost({
            ...clientHostCookieImportTarget(
              initialState,
              runtimeEnvironmentId,
              profileId,
              pageRoute
            ),
            browserFamily,
            browserProfile
          })
          ranOnClient = clientHostResult != null
          const pairingRevision = captureRuntimeEnvironmentRequestRevision(runtimeEnvironmentId)
          const result: BrowserProfileImportFromBrowserResult =
            clientHostResult ??
            (await callRuntimeRpc<BrowserProfileImportFromBrowserResult>(
              { kind: 'environment', environmentId: runtimeEnvironmentId },
              'browser.profileImportFromBrowser',
              { profileId, browserFamily, browserProfile, supportsPartitionSkippedCookies: true },
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
            await get()
              .fetchBrowserSessionProfiles(hostId)
              .catch(() => {})
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
        // Settings on an SSH host fills that host's jar for the profile, on this computer.
        const result: BrowserCookieImportResult = await window.api.browser.sessionImportFromBrowser(
          {
            profileId,
            browserFamily,
            browserProfile,
            ...(parsedHostId?.kind === 'ssh' ? { sshTargetId: parsedHostId.targetId } : {})
          }
        )
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

    clearBrowserProfileCookies: async ({ hostId, profileId, pairingRevision }) => {
      const parsedHostId = parseExecutionHostId(hostId)
      let ok = false
      try {
        if (parsedHostId?.kind === 'ssh') {
          ok = await window.api.browser.sessionClearCookiesForSshHost({
            sshTargetId: parsedHostId.targetId,
            profileId
          })
        } else if (parsedHostId?.kind === 'runtime') {
          ok = await clearPairedServerProfileCookies(
            get,
            hostId,
            parsedHostId.environmentId,
            profileId,
            pairingRevision
          )
        } else {
          ok = await window.api.browser.sessionClearCookies({ profileId })
          if (ok) {
            get().recordFeatureInteraction?.('cookie-import')
          }
        }
      } catch {
        ok = false
      }
      // Even a partial clear drops a badge, so the rows re-read either way.
      await get()
        .fetchBrowserSessionProfiles(hostId)
        .catch(() => {})
      return ok
    }
  }
}
