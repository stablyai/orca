import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from '@/lib/browser/workspace/ssh-workspace-browser-route-eligibility'
import { selectWorktreeHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import type {
  BrowserSlice,
  BrowserSshPageCookieImportRoute
} from '@/store/slices/browser/browser-slice-contract'

/** Pages mount only once SshRoutedBrowserPageGate has verified the route, so an eligible host is the page's jar. */
export function useBrowserPageSshCookieImportRoute(
  worktreeId: string
): BrowserSshPageCookieImportRoute | null {
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
  return useMemo(
    () => (sshTargetId && hostLabel ? { sshTargetId, hostLabel } : null),
    [sshTargetId, hostLabel]
  )
}

type BrowserPageCookieImportBrowsers = Pick<
  BrowserSlice,
  'detectedBrowsers' | 'detectedBrowsersLoaded' | 'fetchDetectedBrowsers'
>

/** An SSH page imports from this desktop's browsers, whichever host Settings › Browser shows. */
export function useBrowserPageCookieImportBrowsers(
  sshRoute: BrowserSshPageCookieImportRoute | null
): BrowserPageCookieImportBrowsers {
  const settingsHostBrowsers = useAppStore((s) => s.detectedBrowsers)
  const settingsHostBrowsersLoaded = useAppStore((s) => s.detectedBrowsersLoaded)
  const fetchSettingsHostBrowsers = useAppStore((s) => s.fetchDetectedBrowsers)
  const [desktopBrowsers, setDesktopBrowsers] = useState<BrowserSlice['detectedBrowsers'] | null>(
    null
  )
  const fetchDesktopBrowsers = useCallback(
    () =>
      window.api.browser
        .sessionDetectBrowsers()
        .then(setDesktopBrowsers)
        .catch(() => setDesktopBrowsers([])),
    []
  )
  if (!sshRoute) {
    return {
      detectedBrowsers: settingsHostBrowsers,
      detectedBrowsersLoaded: settingsHostBrowsersLoaded,
      fetchDetectedBrowsers: fetchSettingsHostBrowsers
    }
  }
  return {
    detectedBrowsers: desktopBrowsers ?? [],
    detectedBrowsersLoaded: desktopBrowsers !== null,
    fetchDetectedBrowsers: fetchDesktopBrowsers
  }
}
