import { runtimeEnvironmentIdUnlessTwin } from '@/lib/workspace/ownership/resolve-owner'
import { useAppStore } from '@/store'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../../shared/workspace-layout/terminal-surface-id'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { activateTerminalTabOnOwner } from '@/lib/workspace/tabs/terminal-tab-owner-activation'
import type { TerminalPaneRevealTarget } from '../../../../../shared/workspace-layout/terminal-surfaces/terminal-pane-reveal'

/** Map host terminal IDs to prefixed client mirrors before reveal; leaf IDs remain stable. */
function toWindowTabId(target: TerminalPaneRevealTarget): string {
  const host = parseExecutionHostId(target.executionHostId)
  const environmentId = host
    ? host.kind === 'runtime'
      ? host.environmentId
      : null
    : // Why: reveal only focuses a tab; a twin keeps the id the caller named.
      runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), target.worktreeId)
  return environmentId && !isWebTerminalSurfaceTabId(target.tabId)
    ? toWebTerminalSurfaceTabId(target.tabId)
    : target.tabId
}

/** Reveal through the workspace dispatcher on local/SSH/server/floating owners. Bare setActiveWorktree skips terminal view, sleeping resume and surface seeding, leaving parked SSH workspaces empty (#16731). Return false for unknown workspaces. */
export function revealTerminalPane(target: TerminalPaneRevealTarget): boolean {
  const activated = activateAndRevealWorkspace(
    target.worktreeId,
    target.executionHostId ? { executionHostId: target.executionHostId } : undefined
  )
  if (activated === false) {
    return false
  }
  const tabId = toWindowTabId(target)
  activateTabAndFocusPane(tabId, target.leafId, { flashFocusedPane: true })
  activateTerminalTabOnOwner(target.worktreeId, tabId, target.leafId)
  return true
}
