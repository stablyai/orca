import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from '@/lib/browser/workspace/ssh-workspace-browser-route-eligibility'
import {
  selectExecutionHostDisplayLabel,
  selectWorktreeHostDisplayLabel
} from '@/runtime/hosts/display/execution-host-display-label'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type {
  BrowserPageCookieImportRoute,
  BrowserSlice
} from '@/store/slices/browser/browser-slice-contract'

type BrowserPageCookieImport = Pick<
  BrowserSlice,
  'detectedBrowsers' | 'detectedBrowsersLoaded' | 'fetchDetectedBrowsers'
> & {
  /** The page's own jar, whatever host Settings › Browser shows. */
  pageRoute: BrowserPageCookieImportRoute
}

/** A server's page this desktop hosts; its import fills that page's jar. */
export type BrowserClientHostedCookieImportPage = { environmentId: string; browserPageId: string }

/**
 * Where a page's cookie import lands and which browsers it offers. Pages mount only once
 * SshRoutedBrowserPageGate has verified the route, so an eligible host is the page's jar. Every
 * page imports this desktop's browsers, even when Settings › Browser shows a paired server.
 */
export function useBrowserPageCookieImport(
  worktreeId: string,
  clientHostedPage: BrowserClientHostedCookieImportPage | null = null
): BrowserPageCookieImport {
  const sshTargetId = useAppStore((s) => {
    if (clientHostedPage) {
      return null
    }
    const eligibility = resolveSshWorkspaceBrowserRouteEligibility(
      getExecutionHostIdForWorktree(s, worktreeId),
      s.settings,
      s.runtimeEnvironments
    )
    return eligibility?.eligible ? eligibility.targetId : null
  })
  const environmentId = clientHostedPage?.environmentId ?? null
  const browserPageId = clientHostedPage?.browserPageId ?? null
  const hostLabel = useAppStore((s) => {
    if (environmentId) {
      return selectExecutionHostDisplayLabel(s, toRuntimeExecutionHostId(environmentId))
    }
    return sshTargetId ? (selectWorktreeHostDisplayLabel(s, worktreeId) ?? sshTargetId) : null
  })
  const [desktopBrowsers, setDesktopBrowsers] = useState<BrowserSlice['detectedBrowsers'] | null>(
    null
  )
  // Not the store's list: that follows the Settings host, which may be a paired server.
  const fetchDesktopBrowsers = useCallback(async (): Promise<void> => {
    if (desktopBrowsers !== null) {
      return
    }
    await window.api.browser
      .sessionDetectBrowsers()
      .then(setDesktopBrowsers)
      .catch(() => setDesktopBrowsers([]))
  }, [desktopBrowsers])
  const pageRoute = useMemo((): BrowserPageCookieImportRoute => {
    if (environmentId && browserPageId) {
      return {
        kind: 'client-host',
        environmentId,
        browserPageId,
        hostLabel: hostLabel ?? environmentId
      }
    }
    return sshTargetId && hostLabel ? { kind: 'ssh', sshTargetId, hostLabel } : { kind: 'local' }
  }, [environmentId, browserPageId, sshTargetId, hostLabel])
  return {
    pageRoute,
    detectedBrowsers: desktopBrowsers ?? [],
    detectedBrowsersLoaded: desktopBrowsers !== null,
    fetchDetectedBrowsers: fetchDesktopBrowsers
  }
}
