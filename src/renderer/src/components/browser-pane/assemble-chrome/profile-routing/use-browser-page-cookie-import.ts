import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from '@/lib/browser/workspace/ssh-workspace-browser-route-eligibility'
import { selectWorktreeHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import type {
  BrowserSlice,
  BrowserSshPageCookieImportRoute
} from '@/store/slices/browser/browser-slice-contract'

type BrowserPageCookieImport = Pick<
  BrowserSlice,
  'detectedBrowsers' | 'detectedBrowsersLoaded' | 'fetchDetectedBrowsers'
> & {
  /** Set when the page browses through an SSH host, whose jar the import fills. */
  sshRoute: BrowserSshPageCookieImportRoute | null
}

/**
 * Where a page's cookie import lands and which browsers it offers. Pages mount only once
 * SshRoutedBrowserPageGate has verified the route, so an eligible host is the page's jar; an SSH
 * page reads this desktop's browsers even when Settings › Browser shows a paired server.
 */
export function useBrowserPageCookieImport(worktreeId: string): BrowserPageCookieImport {
  const sshTargetId = useAppStore((s) => {
    const eligibility = resolveSshWorkspaceBrowserRouteEligibility(
      getExecutionHostIdForWorktree(s, worktreeId),
      s.settings,
      s.runtimeEnvironments
    )
    return eligibility?.eligible ? eligibility.targetId : null
  })
  const hostLabel = useAppStore((s) =>
    sshTargetId ? (selectWorktreeHostDisplayLabel(s, worktreeId) ?? sshTargetId) : null
  )
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const detectedBrowsersLoaded = useAppStore((s) => s.detectedBrowsersLoaded)
  const fetchDetectedBrowsers = useAppStore((s) => s.fetchDetectedBrowsers)
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
  const sshRoute = useMemo(
    () => (sshTargetId && hostLabel ? { sshTargetId, hostLabel } : null),
    [sshTargetId, hostLabel]
  )
  if (!sshRoute) {
    return { sshRoute, detectedBrowsers, detectedBrowsersLoaded, fetchDetectedBrowsers }
  }
  return {
    sshRoute,
    detectedBrowsers: desktopBrowsers ?? [],
    detectedBrowsersLoaded: desktopBrowsers !== null,
    fetchDetectedBrowsers: fetchDesktopBrowsers
  }
}
