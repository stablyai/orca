import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { splitWebRuntimeTerminal } from '@/runtime/web-runtime-terminal-actions'
import type { PtyTransport } from './pty-transport-types'
import { resolveSplitCwd, type PaneCwdMap } from './resolve-split-cwd'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { expectPaneToAppear } from '@/runtime/layout-owner-pane-intents'
import { layoutFramesFlowing } from '@/runtime/layout-frame-position'
import { mintStablePaneId } from '@/lib/pane-manager/mint-stable-pane-id'

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
  const ptyId = args.paneTransports.get(args.pane.id)?.getPtyId() ?? null
  if (
    splitWebRuntimeTerminal(ptyId, args.direction, args.source, {
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      leafId: args.pane.leafId
    })
  ) {
    return
  }
  // Switch point: main writes the split; the window draws it from main's frame, with its cwd.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const newLeafId = mintStablePaneId()
    const cwd = splitCwd(args, ptyId)
    const forget = expectPaneToAppear(newLeafId, {
      tabId: args.tabId,
      ...cwd,
      telemetry: { source: args.source, direction: args.direction }
    })
    if (
      sendLayoutCommandToOwner(
        args.worktreeId,
        {
          type: 'splitPane',
          tabId: args.tabId,
          leafId: args.pane.leafId,
          direction: args.direction,
          newLeafId
        },
        {
          // No frame is coming (the stream is down): the window draws main's pane itself.
          apply: () => {
            if (!layoutFramesFlowing()) {
              forget()
              splitLocally(args, () => cwd, newLeafId)
            }
          },
          asToday: () => {
            forget()
            splitLocally(args, () => cwd)
          },
          refused: forget
        }
      )
    ) {
      return
    }
    forget()
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
function splitLocally(args: SplitArgs, cwd: () => SplitCwd, leafId?: string): void {
  const manager = args.getManager ? args.getManager() : args.manager
  if (!manager) {
    return
  }
  const createdPane = manager.splitPane(args.pane.id, args.direction, {
    ...cwd(),
    ...(leafId ? { leafId } : {})
  })
  recordCreatedTerminalPaneSplit(createdPane, {
    source: args.source,
    direction: args.direction
  })
}
