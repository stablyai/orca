import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import {
  isAccountRestartReady,
  selectReadyAccountRestartPtyIds
} from './pane-account-restart-readiness'
import {
  beginCloudAgentRestart,
  failCloudAgentRestart,
  failCloudAgentRestartAfterLaunch,
  noteCloudAgentRestartFresh,
  isForcedCloudAgentRestart,
  noteCloudAgentRestartLaunched
} from '@/lib/orca-cloud/cloud-agent-restart-attempt'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import type { usePaneProcessRestart } from '../process-exit/use-pane-process-restart'
import {
  freshIfResumeFoundNothing,
  resumeRemotePaneAgent,
  stopRemotePaneTerminalForRestart
} from '@/lib/orca-cloud/cloud-pane-restart-stop'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  expectPaneBindsHandle,
  remotePtyIdWithHandle
} from '@/lib/orca-cloud/cloud-restart-bind-check'
import { waitForResumedTerminalReady } from '@/lib/orca-cloud/cloud-resumed-terminal-ready'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import { defaultLaunchConfig, freshCommandFor } from '@/lib/orca-cloud/cloud-restart-launch-command'
import { buildFreshAccountRestartCommand } from '@/lib/agent-session/accounts/agent-account-restart-startup'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type { usePaneAccountRestartStartup } from './use-pane-account-restart-startup'

export function useReadyPaneAccountRestarts({
  consumePendingPaneAccountRestart,
  managerRef,
  paneTransportsRef,
  tabId,
  buildAccountRestartStartup,
  handleRestartPane,
  releasePaneForRestart,
  panePtyLayoutBindings
}: Pick<
  TerminalPaneCloseController,
  'consumePendingPaneAccountRestart' | 'managerRef' | 'paneTransportsRef' | 'tabId'
> & {
  buildAccountRestartStartup: ReturnType<
    typeof usePaneAccountRestartStartup
  >['buildAccountRestartStartup']
  handleRestartPane: ReturnType<typeof usePaneProcessRestart>['handleRestartPane']
  releasePaneForRestart: ReturnType<typeof usePaneProcessRestart>['releasePaneForRestart']
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
      handleRestartPane,
      releasePaneForRestart
    })
  }, [
    buildAccountRestartStartup,
    consumePendingPaneAccountRestart,
    handleRestartPane,
    releasePaneForRestart,
    panePtyLayoutBindings,
    readyRestartPtyIds,
    managerRef,
    paneTransportsRef,
    tabId
  ])
}

type ReadyRestartPane = { id: number; leafId: string }

function worktreeIdForTab(tabId: string): string | null {
  for (const [worktreeId, tabs] of Object.entries(useAppStore.getState().tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

/**
 * Run each of this tab's queued account restarts that may run now. A restart on a paired (remote)
 * pane, or one clicked on the Orca Cloud strip, reports its outcome (launched, or failed) so it never
 * ends silently.
 */
export function runReadyPaneAccountRestarts<
  Startup extends {
    resumeProviderSession?: AgentProviderSessionMetadata
    launchConfig?: SleepingAgentLaunchConfig
  }
>(input: {
  panes: readonly ReadyRestartPane[]
  ptyIdOf: (paneId: number) => string | null
  readyRestartPtyIds: readonly string[]
  tabId: string
  consumePendingPaneAccountRestart: (ptyId: string) => AccountRestartAgent | null
  buildAccountRestartStartup: (agent: AccountRestartAgent, leafId: string) => Startup | null
  handleRestartPane: (paneId: number, startup: Startup, options: { focus: boolean }) => void
  /**
   * Destroys the pane's transport without reconnecting. A paired pane's transport otherwise reacts to
   * its own host terminal stopping by reattaching, which wakes the leaf with its original launch
   * before the resume lands (RA-11 resume race).
   */
  releasePaneForRestart?: (paneId: number) => void
  /** Stops the one host terminal behind a paired pane before its restart reconnects. */
  stopRemotePane?: (ptyId: string, worktreeId: string) => Promise<void>
  /** Relaunches the paired pane's agent on its own conversation, in the same pane. */
  resumeRemotePane?: typeof resumeRemotePaneAgent
  /** RA-11 resume race: wait until the resumed terminal is live in the pane's own leaf. */
  waitForResumedTerminal?: typeof waitForResumedTerminalReady
  /** RA-11e: start fresh in the same pane when a resume found no conversation. */
  freshIfResumeFoundNothing?: typeof freshIfResumeFoundNothing
  /** The fresh-launch command for this tab's pane (no session to resume). */
  buildFreshCommand?: (
    agent: AccountRestartAgent,
    leafId: string,
    agentArgs?: string | null
  ) => string
}): void {
  const args = {
    stopRemotePane: stopRemotePaneTerminalForRestart,
    resumeRemotePane: resumeRemotePaneAgent,
    waitForResumedTerminal: waitForResumedTerminalReady,
    freshIfResumeFoundNothing,
    buildFreshCommand: (agent: AccountRestartAgent, leafId: string, agentArgs?: string | null) =>
      buildFreshAccountRestartCommand(
        agent,
        {
          tabId: input.tabId,
          leafId,
          worktreeId: worktreeIdForTab(input.tabId) ?? ''
        },
        agentArgs
      ),
    ...input
  }
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
    const providerSession = launchedStartup.resumeProviderSession ?? null
    // RA-11c: on a paired pane a reconnect alone reattaches to the running agent (the host hands back
    // its live terminal), so every restart there takes the stop → resume → reconnect path, and an
    // account-switch restart is tracked like a strip Restart: proof of a new PTY, else a failure.
    const worktreeId = isRemoteRuntimePtyId(ptyId) ? worktreeIdForTab(args.tabId) : null
    // Tracked (the strip shows "Restarting…" and a result) only where that strip lives: Orca Cloud.
    const onOrcaCloud = isOrcaCloudEnvironmentId(
      parseRemoteRuntimePtyId(ptyId)?.environmentId ?? ''
    )
    const tracked = forced || (worktreeId !== null && onOrcaCloud)
    if (tracked && !forced) {
      beginCloudAgentRestart(
        makePaneKey(args.tabId, pane.leafId),
        { agent, resumable: providerSession !== null, ptyId },
        () => undefined
      )
    }
    const launch = (): void => {
      if (tracked) {
        noteCloudAgentRestartLaunched(ptyId)
      }
      // Why: one Claude switch restarts many panes at once; none was the one the user clicked.
      args.handleRestartPane(pane.id, launchedStartup, {
        focus: agent === 'codex'
      })
    }
    if (!worktreeId) {
      launch()
      continue
    }
    // RA-11d: the pane's recorded launch, or (a host-launched agent the desktop never recorded) the
    // agent's default CLI args, the same source the create launch read.
    // RA-11d: the resume plan always carries a launch config, with empty args when nothing was
    // recorded (a host-launched agent); only real recorded args win over the defaults.
    const recorded = launchedStartup.launchConfig
    const defaults = recorded?.agentArgs?.trim() ? undefined : defaultLaunchConfig(agent)
    // Substitute only the args: the recorded env (and command) stay the pane's own.
    const launchConfig =
      defaults && recorded ? { ...recorded, agentArgs: defaults.agentArgs } : (recorded ?? defaults)
    // Stop that one host terminal first (its exit is ours, not the pane's), then reconnect.
    const store = useAppStore.getState()
    store.suppressPtyExit(ptyId)
    // Order is stop → ensure → reconnect: let go of the pane's transport before the stop, or its own
    // recovery reattaches the moment the stop ends its stream and wakes the original launch.
    args.releasePaneForRestart?.(pane.id)
    void args
      .stopRemotePane(ptyId, worktreeId)
      .then(() =>
        providerSession
          ? args.resumeRemotePane({
              // RA-11d: the pane's own launch (model, effort, every flag), not the host defaults.
              ...(launchConfig ? { launchConfig } : {}),
              ptyId,
              worktreeId,
              tabId: args.tabId,
              leafId: pane.leafId,
              agent,
              providerSession
            })
          : undefined
      )
      .then(async (resumed) => {
        // RA-11 resume race: reconnect only once the resumed terminal is live in this very leaf;
        // an earlier reconnect would wake the leaf with its original launch and drop the resume.
        if (resumed) {
          await args.waitForResumedTerminal({
            ptyId,
            worktreeId,
            tabId: args.tabId,
            leafId: pane.leafId,
            handle: resumed.handle
          })
        }
        return resumed
      })
      .then(
        (resumed) => {
          launch()
          if (resumed && tracked) {
            // The pane must end on the resumed terminal; anything else is a new conversation.
            expectPaneBindsHandle({
              tabId: args.tabId,
              leafId: pane.leafId,
              replacedPtyId: ptyId,
              handle: resumed.handle,
              onMismatch: (bound) => {
                console.warn(
                  '[orca-cloud] RA-11 restart bound',
                  bound,
                  'not the resumed',
                  resumed.handle
                )
                failCloudAgentRestartAfterLaunch(makePaneKey(args.tabId, pane.leafId), {
                  agent,
                  ptyId: remotePtyIdWithHandle(ptyId, bound)
                })
              }
            })
          }
          if (providerSession) {
            // RA-11e: a session with no conversation can't resume; start fresh in the same pane, once.
            void Promise.resolve()
              .then(() =>
                args.freshIfResumeFoundNothing({
                  currentPtyId: () =>
                    useAppStore.getState().terminalLayoutsByTabId[args.tabId]?.ptyIdsByLeafId?.[
                      pane.leafId
                    ] ?? null,
                  replacedPtyId: ptyId,
                  // RA-11d: a fresh fallback keeps the pane's own model, effort and flags too.
                  freshCommand: freshCommandFor(
                    () => args.buildFreshCommand(agent, pane.leafId, launchConfig?.agentArgs),
                    agent
                  )
                })
              )
              .then((startedFresh) => {
                if (startedFresh) {
                  // Never claim the conversation came back when it didn't.
                  noteCloudAgentRestartFresh(makePaneKey(args.tabId, pane.leafId))
                }
              })
              .catch((err: unknown) => {
                console.warn('[orca-cloud] fresh fallback failed:', err)
                if (tracked) {
                  // The pane is a bare shell now: say so with Try again, never leave it quiet.
                  failCloudAgentRestartAfterLaunch(makePaneKey(args.tabId, pane.leafId), {
                    agent,
                    ptyId:
                      useAppStore.getState().terminalLayoutsByTabId[args.tabId]?.ptyIdsByLeafId?.[
                        pane.leafId
                      ] ?? ptyId
                  })
                }
              })
          }
        },
        (err: unknown) => {
          console.warn('[orca-cloud] restart could not relaunch the pane’s agent on its host:', err)
          useAppStore.getState().consumeSuppressedPtyExit(ptyId)
          // The host did not stop or relaunch it: the strip names that reason.
          failCloudAgentRestart(ptyId, 'hostUnresponsive')
          if (args.releasePaneForRestart) {
            // Its transport was let go before the stop: reattach so the pane is never left empty
            // (the still-live terminal, or the leaf's own launch if the stop went through).
            args.handleRestartPane(pane.id, launchedStartup, { focus: false })
          }
          if (!forced && agent === 'codex') {
            // The switch was answered on the old account: ask again rather than leave it silently stale.
            useAppStore.getState().reopenCodexRestartPrompt(ptyId)
          }
        }
      )
  }
}
