import { useAppStore } from '@/store/index'
import { captureHttpLinkIntent } from '@/lib/browser/navigation/http-link-routing'
import {
  getFloatingWorkspaceOperationRoute,
  resolveWorktreeOperationRoute
} from '@/lib/workspace/ownership/worktree-operation-route'
import type { LinkActionContext } from '@/lib/browser/navigation/http-link-destinations'

/** Everything a chooser action needs, captured at click so later focus or host changes cannot redirect it. */
export function captureLinkActionContext(
  worktreeId: string,
  sourceTabId: string | null | undefined
): LinkActionContext {
  const linkIntent = captureHttpLinkIntent(worktreeId, sourceTabId)
  const route =
    getFloatingWorkspaceOperationRoute(worktreeId) ??
    resolveWorktreeOperationRoute(useAppStore.getState(), worktreeId)
  return {
    linkIntent,
    groupIntent: captureHttpLinkIntent(worktreeId, sourceTabId, true),
    clickHostId: linkIntent?.hostId ?? route?.executionHostId ?? null
  }
}
