import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import {
  isAccountRestartReady,
  selectReadyAccountRestartPtyIds
} from './pane-account-restart-readiness'
import {
  failCloudAgentRestart,
  isForcedCloudAgentRestart,
  noteCloudAgentRestartLaunched
} from '@/lib/orca-cloud/cloud-agent-restart-attempt'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import type { usePaneProcessRestart } from '../process-exit/use-pane-process-restart'
import { stopRemotePaneTerminalForRestart } from '@/lib/orca-cloud/cloud-pane-restart-stop'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type { usePaneAccountRestartStartup } from './use-pane-account-restart-startup'

export function useReadyPaneAccountRestarts({
  consumePendingPaneAccountRestart,
  managerRef,
  paneTransportsRef,
  tabId,
  buildAccountRestartStartup,
  handleRestartPane,
  panePtyLayoutBindings
}: Pick<
  TerminalPaneCloseController,
  'consumePendingPaneAccountRestart' | 'managerRef' | 'paneTransportsRef' | 'tabId'
> & {
  buildAccountRestartStartup: ReturnType<
    typeof usePaneAccountRestartStartup
  >['buildAccountRestartStartup']
  handleRestartPane: ReturnType<typeof usePaneProcessRestart>['handleRestartPane']
  panePtyLayoutBindings: TerminalPaneCloseController['savedLayout']['ptyIdsByLeafId']
}) {
  // Why primitive ids: unrelated status updates stay shallow-equal and skip this pane.
  const readyRestartPtyIds = useAppStore(
    useShallow((state) => selectReadyAccountRestartPtyIds(state, tabId))
  )
  useEffect(() => {
    const manager = managerRef.current
    if (!manager || readyRestartPtyIds.length === 0) {
      return
    }
    runReadyPaneAccountRestarts({
      panes: manager.getPanes(),
      ptyIdOf: (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId() ?? null,
      readyRestartPtyIds,
      tabId,
      consumePendingPaneAccountRestart,
      buildAccountRestartStartup,
      handleRestartPane
    })
  }, [
    buildAccountRestartStartup,
    consumePendingPaneAccountRestart,
    handleRestartPane,
    panePtyLayoutBindings,
    readyRestartPtyIds,
    managerRef,
    paneTransportsRef,
    tabId
  ])
}

type ReadyRestartPane = { id: number; leafId: string }

/**
 * Run each of this tab's queued account restarts that may run now. An RA-11 Restart clicked on the
 * Orca Cloud strip reports its outcome (launched, or failed) so the strip never vanishes silently.
 */
function worktreeIdForTab(tabId: string): string | null {
  for (const [worktreeId, tabs] of Object.entries(useAppStore.getState().tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

export function runReadyPaneAccountRestarts<Startup>(input: {
  panes: readonly ReadyRestartPane[]
  ptyIdOf: (paneId: number) => string | null
  readyRestartPtyIds: readonly string[]
  tabId: string
  consumePendingPaneAccountRestart: (ptyId: string) => AccountRestartAgent | null
  buildAccountRestartStartup: (agent: AccountRestartAgent, leafId: string) => Startup | null
  handleRestartPane: (paneId: number, startup: Startup, options: { focus: boolean }) => void
  /** Stops the one host terminal behind a paired pane before its restart reconnects. */
  stopRemotePane?: (ptyId: string, worktreeId: string) => Promise<void>
}): void {
  const args = { stopRemotePane: stopRemotePaneTerminalForRestart, ...input }
  for (const pane of args.panes) {
    const ptyId = args.ptyIdOf(pane.id)
    if (
      !ptyId ||
      !args.readyRestartPtyIds.includes(ptyId) ||
      !isAccountRestartReady(useAppStore.getState(), args.tabId, pane.leafId, ptyId)
    ) {
      continue
    }
    const forced = isForcedCloudAgentRestart(ptyId)
    const agent = args.consumePendingPaneAccountRestart(ptyId)
    let startup: Startup | null = null
    try {
      startup = agent ? args.buildAccountRestartStartup(agent, pane.leafId) : null
    } catch (err) {
      // RA-11: a Restart clicked on the strip reports this; any other caller keeps its old behavior.
      if (!forced) {
        throw err
      }
      console.warn('[orca-cloud] restart startup failed:', err)
    }
    if (!agent || !startup) {
      if (forced) {
        failCloudAgentRestart(ptyId)
      }
      continue
    }
    const launchedStartup = startup
    const launch = (): void => {
      if (forced) {
        noteCloudAgentRestartLaunched(ptyId)
      }
      // Why: one Claude switch restarts many panes at once; none was the one the user clicked.
      args.handleRestartPane(pane.id, launchedStartup, { focus: agent === 'codex' })
    }
    const worktreeId = forced && isRemoteRuntimePtyId(ptyId) ? worktreeIdForTab(args.tabId) : null
    if (!worktreeId) {
      launch()
      continue
    }
    // RA-11 on a paired pane: a reconnect alone reattaches to the running agent. Stop that one host
    // terminal first (its exit is ours, not the pane's), then reconnect.
    const store = useAppStore.getState()
    store.suppressPtyExit(ptyId)
    void args.stopRemotePane(ptyId, worktreeId).then(launch, (err: unknown) => {
      console.warn('[orca-cloud] restart could not stop the pane’s host terminal:', err)
      useAppStore.getState().consumeSuppressedPtyExit(ptyId)
      failCloudAgentRestart(ptyId)
    })
  }
}
