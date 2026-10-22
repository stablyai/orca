// Layout-owner build: the window's splits are written and started by main under the window's pane
// id. Main's frame draws the pane, which attaches to main's terminal (frame reconciliation).
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { mintStablePaneId } from '@/lib/pane-manager/mint-stable-pane-id'
import { refusalActsAsToday } from '@/runtime/layout-apply-send'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { expectPaneToMountUnfocused } from '@/runtime/layout-owner-pane-intents'
import { useAppStore } from '@/store'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'

export type SplitInMainRequest = {
  worktreeId: string
  tabId: string
  sourceLeafId: string
  direction: 'vertical' | 'horizontal'
  cwd?: string | Promise<string>
  initialSize?: { cols: number; rows: number }
  command?: string
  env?: Record<string, string>
  /** The user's split; startup splits record no interaction. */
  telemetry?: { source: TerminalPaneSplitSource }
  /** Focus stays on the source pane when the new pane mounts, as a startup split's does. */
  keepSourceFocused?: true
}

/**
 * Asks main to split. False when a paired server owns the workspace's layout: the caller splits
 * as today, as it does through `asToday` when main finds the tab is a paired server's twin.
 */
export function splitPaneInMain(request: SplitInMainRequest, asToday: () => void): boolean {
  const { worktreeId, tabId, sourceLeafId, direction, telemetry } = request
  if (runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), worktreeId)) {
    return false
  }
  const newLeafId = mintStablePaneId()
  const forgetFocus = request.keepSourceFocused
    ? expectPaneToMountUnfocused(tabId, newLeafId)
    : () => {}
  void (async () => {
    const cwd = await request.cwd
    await callRuntimeRpc({ kind: 'local' }, 'terminal.split', {
      pane: { worktreeId, tabId, leafId: sourceLeafId },
      newLeafId,
      direction,
      ...(cwd ? { cwd } : {}),
      ...(request.initialSize ? { initialSize: request.initialSize } : {}),
      ...(request.command ? { command: request.command } : {}),
      ...(request.env ? { env: request.env } : {})
    })
  })().then(
    () => {
      if (telemetry) {
        recordCreatedTerminalPaneSplit(true, { source: telemetry.source, direction })
      }
    },
    (error: unknown) => {
      forgetFocus()
      const message = error instanceof Error ? error.message : String(error)
      if (
        message === 'host_not_owned' &&
        refusalActsAsToday(useAppStore.getState(), worktreeId, 'host_not_owned')
      ) {
        asToday()
        return
      }
      // A start that failed keeps its pane, which shows why; anything else left no pane.
      console.warn('[layout-owner] split refused:', message)
    }
  )
  return true
}

/** A first size for the new pane: its share of the source pane's grid, until it is laid out. */
export function splitPaneFirstSize(
  source: { cols: number; rows: number },
  direction: 'vertical' | 'horizontal'
): { cols: number; rows: number } {
  return direction === 'vertical'
    ? { cols: Math.max(1, Math.floor(source.cols / 2)), rows: source.rows }
    : { cols: source.cols, rows: Math.max(1, Math.floor(source.rows / 2)) }
}
