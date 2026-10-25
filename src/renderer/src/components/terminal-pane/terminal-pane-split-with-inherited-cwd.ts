import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { splitWebRuntimeTerminal } from '@/runtime/web-runtime-terminal-actions'
import {
  isHostTabPane,
  notifyHostTabSplitRefused,
  readHostPublishedSplitSourcePtyId
} from '@/runtime/web-runtime-split-source-pty'
import type { PtyTransport } from './pty-transport-types'
import { resolveSplitCwd, type PaneCwdMap } from './resolve-split-cwd'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  splitPaneFirstSize,
  splitPaneInMain,
  splitServerPane,
  type SplitInMainRequest
} from './terminal-pane-split-in-main'

type SplitArgs = {
  worktreeId: string
  tabId: string
  manager: PaneManager
  getManager?: () => PaneManager | null
  paneTransports: Map<number, PtyTransport>
  paneCwdMap: PaneCwdMap
  fallbackCwd: string
  pane: ManagedPane
  direction: 'vertical' | 'horizontal'
  source: TerminalPaneSplitSource
}

export function splitTerminalPaneWithInheritedCwd(args: SplitArgs): void {
  const sourcePane = { worktreeId: args.worktreeId, tabId: args.tabId, leafId: args.pane.leafId }
  // Why the host's binding: a pane whose attach is still in flight has no transport id yet.
  const ptyId =
    args.paneTransports.get(args.pane.id)?.getPtyId() ??
    readHostPublishedSplitSourcePtyId(sourcePane)
  if (splitWebRuntimeTerminal(ptyId, args.direction, args.source, sourcePane)) {
    return
  }
  // Switch point: main writes the split and starts its terminal; main's frame draws the pane. A
  // server workspace's handle-less pane goes to that server's main while its frames draw it.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const cwd = splitCwd(args, ptyId)
    const asToday = (): void => splitLocally(args, () => cwd)
    const request: SplitInMainRequest = {
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      sourceLeafId: args.pane.leafId,
      direction: args.direction,
      cwd: 'cwd' in cwd ? cwd.cwd : cwd.cwdPromise,
      initialSize: splitPaneFirstSize(args.pane.terminal, args.direction),
      telemetry: { source: args.source }
    }
    if (splitPaneInMain(request, asToday) || splitServerPane(request)) {
      return
    }
  }
  if (isHostTabPane(sourcePane)) {
    notifyHostTabSplitRefused(sourcePane)
    return
  }
  splitLocally(args, () => splitCwd(args, ptyId))
}

/** The new pane's cwd: the source pane's when known, else resolved from its terminal. */
type SplitCwd = { cwd: string } | { cwdPromise: Promise<string> }

function splitCwd(args: SplitArgs, ptyId: string | null): SplitCwd {
  const cached = args.paneCwdMap.get(args.pane.id)
  if (cached?.confirmed && cached.cwd) {
    return { cwd: cached.cwd }
  }
  return {
    cwdPromise:
      cached?.pendingCwd ??
      resolveSplitCwd({
        paneCwdMap: args.paneCwdMap,
        sourcePaneId: args.pane.id,
        sourcePtyId: ptyId,
        fallbackCwd: args.fallbackCwd
      })
  }
}

/** `cwd` is read only once a manager is there to split. */
function splitLocally(args: SplitArgs, cwd: () => SplitCwd): void {
  const manager = args.getManager ? args.getManager() : args.manager
  if (!manager) {
    return
  }
  const createdPane = manager.splitPane(args.pane.id, args.direction, cwd())
  recordCreatedTerminalPaneSplit(createdPane, {
    source: args.source,
    direction: args.direction
  })
}
