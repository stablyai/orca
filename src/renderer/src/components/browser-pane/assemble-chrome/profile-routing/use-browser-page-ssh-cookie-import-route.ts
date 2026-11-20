import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from '@/lib/browser/workspace/ssh-workspace-browser-route-eligibility'
import { selectWorktreeHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import type { BrowserSshPageCookieImportRoute } from '@/store/slices/browser/browser-slice-contract'

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
