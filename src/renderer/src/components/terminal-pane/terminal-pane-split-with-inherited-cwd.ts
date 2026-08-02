import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { splitWebRuntimeTerminal } from '@/runtime/web-runtime-session'
import type { PtyTransport } from './pty-transport'
import { resolveSplitCwd, type PaneCwdMap } from './resolve-split-cwd'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'

export function splitTerminalPaneWithInheritedCwd(args: {
  manager: PaneManager
  getManager?: () => PaneManager | null
  paneTransports: Map<number, PtyTransport>
  paneCwdMap: PaneCwdMap
  fallbackCwd: string
  pane: ManagedPane
  direction: 'vertical' | 'horizontal'
  source: TerminalPaneSplitSource
}): void {
  const ptyId = args.paneTransports.get(args.pane.id)?.getPtyId() ?? null
  if (splitWebRuntimeTerminal(ptyId, args.direction, args.source)) {
    return
  }
  const cached = args.paneCwdMap.get(args.pane.id)
  if (cached?.confirmed && cached.cwd) {
    const createdPane = args.manager.splitPane(args.pane.id, args.direction, { cwd: cached.cwd })
    recordCreatedTerminalPaneSplit(createdPane, {
      source: args.source,
      direction: args.direction
    })
    return
  }
  const paneId = args.pane.id
  const resolveManager = (): PaneManager | null =>
    args.getManager ? args.getManager() : args.manager
  void (async () => {
    const cwd = await resolveSplitCwd({
      paneCwdMap: args.paneCwdMap,
      sourcePaneId: paneId,
      sourcePtyId: ptyId,
      fallbackCwd: args.fallbackCwd
    })
    const createdPane = resolveManager()?.splitPane(paneId, args.direction, { cwd })
    recordCreatedTerminalPaneSplit(createdPane, {
      source: args.source,
      direction: args.direction
    })
  })()
}
