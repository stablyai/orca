// Main writes/starts splits under the window pane ID; frame reconciliation draws and attaches its terminal.
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { mintStablePaneId } from '@/lib/pane-manager/mint-stable-pane-id'
import { refusalActsAsToday } from '@/runtime/layout-apply-send'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { serverLayoutApplyRoute } from '@/runtime/server-layout-apply-routes'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
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

/** Ask main; paired/twin refusals delegate to the caller’s window split path. */
export function splitPaneInMain(request: SplitInMainRequest, asToday: () => void): boolean {
  if (runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), request.worktreeId)) {
    return false
  }
  sendPaneSplit({ kind: 'local' }, request, request.tabId, (message) => {
    if (
      message === 'host_not_owned' &&
      refusalActsAsToday(useAppStore.getState(), request.worktreeId, 'host_not_owned')
    ) {
      asToday()
      return true
    }
    return false
  })
  return true
}

/** For unbound panes in server-framed workspaces, paired main writes/starts the split and frames draw it; otherwise return false. */
export function splitServerPane(request: SplitInMainRequest): boolean {
  const environmentId = runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), request.worktreeId)
  const route = environmentId ? serverLayoutApplyRoute(environmentId, request.worktreeId) : null
  const serverTabId = route?.serverTabId(request.tabId)
  if (!route || !serverTabId) {
    return false
  }
  sendPaneSplit(
    { kind: 'environment', environmentId: route.environmentId },
    request,
    serverTabId,
    () => false
  )
  return true
}

/** `refusedAsToday`: true when the caller took the refusal over. */
function sendPaneSplit(
  target: RuntimeClientTarget,
  request: SplitInMainRequest,
  hostTabId: string,
  refusedAsToday: (message: string) => boolean
): void {
  const { worktreeId, tabId, sourceLeafId, direction, telemetry } = request
  const newLeafId = mintStablePaneId()
  const forgetFocus = request.keepSourceFocused
    ? expectPaneToMountUnfocused(tabId, newLeafId)
    : () => {}
  void (async () => {
    const cwd = await request.cwd
    await callRuntimeRpc(target, 'terminal.split', {
      pane: { worktreeId, tabId: hostTabId, leafId: sourceLeafId },
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
      if (refusedAsToday(message)) {
        return
      }
      // A start that failed keeps its pane, which shows why; anything else left no pane.
      console.warn('[layout-owner] split refused:', message)
    }
  )
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
