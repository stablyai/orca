import { installPaneResumeRecord, currentMailWakeStartup } from './startup/pane-resume-record'
import { useAppStore } from '@/store/index'
import type { PtyReplayDataMeta } from '../pty-transport/pty-transport-types'
import { INITIAL_MODE_2031_REPLY_SCAN_STATE } from '../../../../../shared/terminal/protocol/queries/terminal-color-scheme-protocol'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import { executeTerminalStartupCommandPaste } from '../input/paste/terminal-startup-command-paste'
import { resolveTerminalPasteRuntime } from '../input/paste/terminal-paste-runtime'
import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'

import { shouldKeepHiddenStartupRendererQueriesLive } from './output/hidden-startup-renderer-query'
import { createForegroundImmediateBudget } from './output/foreground-output-budgets'
import type { FreshSpawnOptions, ColdRestoreAgentResumeStartup } from './startup/fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindCaptureTransportOutputCallbacks } from './lifecycle/transport-output-callbacks'
import { initializeHiddenOutputRestoreState } from './output-restore/hidden-output-restore-state'

import { bindReplayDataDrain } from './output/replay-data-drain'
import { bindStartFreshSpawn } from './spawn/fresh-spawn-start'

import { bindFreshSpawnFollowReset } from './output/fresh-spawn-follow-reset'
import { bindReplacedProcessInputModes } from './output/replaced-process-input-modes'
import { deferHiddenAgentResume } from './spawn/hidden-agent-resume-deferral'
import { holdInPlaceResumeUntilSettled } from './startup/in-place-resume-hold'
import { attachToMainResumedSleepPane, mainResumedSleepPane } from './spawn/main-resumed-sleep-pane'
import { startPaneThroughMainThenAttach } from './spawn/main-pane-start-request'

export function bindDeferredColdRestoreAndSnapshot(session: ConnectPanePtySession): void {
  session.applyColdRestoreAgentResumeStartup = (
    startup: ColdRestoreAgentResumeStartup | null
  ): boolean => {
    if (!startup || startup.resumeSource?.cancelled) {
      return false
    }
    const state = useAppStore.getState()
    if (!session.pendingStartupCommand && session.shouldDeliverStartupViaTerminalPaste) {
      session.pendingStartupCommand = {
        command: startup.command,
        resumeSource: startup.resumeSource
      }
    }
    state.registerAgentLaunchConfig(session.cacheKey, startup.launchConfig, {
      agentType: startup.agent,
      launchToken: startup.launchToken,
      tabId: session.deps.tabId,
      leafId: session.pane.leafId
    })
    if (startup.resumeSource) {
      session.savedStartupLaunchRegistration = {
        source: startup.resumeSource,
        entry: useAppStore.getState().agentLaunchConfigByPaneKey[session.cacheKey]
      }
    }
    return true
  }
  installPaneResumeRecord(session)
  session.mergeStartupEnvWithPaneIdentity = (
    env: Record<string, string> | undefined
  ): Record<string, string> | undefined =>
    env
      ? {
          ...env,
          ...session.paneIdentityEnv,
          ...(env.ORCA_AGENT_LAUNCH_TOKEN
            ? { ORCA_AGENT_LAUNCH_TOKEN: env.ORCA_AGENT_LAUNCH_TOKEN }
            : {})
        }
      : undefined
  // Why ungated: a reveal, a restart replacement on show, or a phone wake already chose to run now.
  session.spawnColdRestoreAgentResume = (
    startup: ColdRestoreAgentResumeStartup | null = session.buildColdRestoreAgentResumeStartup(),
    options: FreshSpawnOptions = {},
    automatic?: boolean
  ): Promise<string | null> => {
    if (startup) {
      startup = currentMailWakeStartup(
        startup,
        useAppStore.getState().sleepingAgentSessionsByPaneKey
      )
    }
    if (startup?.resumeSource?.cancelled) {
      return Promise.resolve(null)
    }
    const mainPane = mainResumedSleepPane(session, startup)
    if (mainPane && startup?.sleepingRecordEntry) {
      return attachToMainResumedSleepPane(session, mainPane, startup, options, automatic)
    }
    return startPaneThroughMainThenAttach(session, () => {
      session.applyColdRestoreAgentResumeStartup(startup)
      const spawned = session.startFreshSpawn(startup, options)
      // Switch point: main's layout shows this pane unbound while the start runs.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        holdInPlaceResumeUntilSettled(() => !session.disposed, startup, spawned)
      }
      return spawned
    })
  }
  session.startFreshColdRestoreAgentResume = (
    startup: ColdRestoreAgentResumeStartup | null = session.buildColdRestoreAgentResumeStartup(),
    options: FreshSpawnOptions = {}
  ): Promise<string | null> =>
    deferHiddenAgentResume(session, startup)
      ? Promise.resolve(null)
      : session.spawnColdRestoreAgentResume(startup, options)
  // Visibility wake runs from the outer binding after this deferred-connect closure returns.
  session.wakeHibernatedAgentPane = () => session.spawnColdRestoreAgentResume()
  const isStartupPasteTargetCurrent = (ptyId: string | null): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
    session.transport.getPtyId() === ptyId
  const runTerminalPasteStartupCommand = async (
    command: string,
    current: () => boolean
  ): Promise<boolean> => {
    const ptyId = session.transport.getPtyId()
    const result = await executeTerminalStartupCommandPaste({
      command,
      pane: session.pane,
      ptyId,
      runtime: resolveTerminalPasteRuntime({
        platform: CLIENT_PLATFORM,
        ptyId,
        transport: session.transport,
        isWindowsConpty: session.isNativeWindowsConpty
      }),
      transport: session.transport,
      isTargetCurrent: (target) => current() && isStartupPasteTargetCurrent(target)
    })
    if (result.status !== 'pasted' || !current() || !isStartupPasteTargetCurrent(ptyId)) {
      return false
    }
    return session.transport.sendInput('\r', 'launch')
  }
  session.schedulePendingStartupCommandDelivery = (): void => {
    const startup = session.pendingStartupCommand
    if (!startup || startup.resumeSource?.cancelled) {
      return
    }
    if (session.startupInjectTimer !== null) {
      clearTimeout(session.startupInjectTimer)
    }
    const generation = session.transportStreamGeneration
    const isCurrent = (): boolean =>
      !session.disposed &&
      session.pendingStartupCommand === startup &&
      !startup.resumeSource?.cancelled &&
      generation === session.transportStreamGeneration &&
      (startup.isCurrent?.() ?? true)
    session.startupInjectTimer = setTimeout(() => {
      session.startupInjectTimer = null
      void (async () => {
        if (!isCurrent()) {
          return
        }
        if (session.shouldDeliverStartupViaTerminalPaste) {
          await waitForTerminalOutputParsed(session.pane.terminal)
        }
        if (!isCurrent()) {
          return
        }
        const command = startup.command
        const submitted = session.shouldDeliverStartupViaTerminalPaste
          ? await runTerminalPasteStartupCommand(command, isCurrent)
          : session.transport.sendInput(`${command}\r`, 'launch')
        if (submitted) {
          session.armStartupDraftReadinessObservation()
        } else {
          session.releaseUnattemptedStartupDraftPasteDelivery()
        }
        if (session.pendingStartupCommand === startup) {
          session.pendingStartupCommand = null
        }
      })()
    }, 50)
  }

  session.freshSpawnFollowResetDisposables = []
  session.cancelFreshSpawnFollowReset = (): void => {
    for (const disposable of session.freshSpawnFollowResetDisposables) {
      disposable.dispose()
    }
    session.freshSpawnFollowResetDisposables = []
  }
  bindFreshSpawnFollowReset(session)
  bindReplacedProcessInputModes(session)
  bindStartFreshSpawn(session)
  bindReplayDataDrain(session)
  session.replayDataCallback = (
    data: string,
    meta: PtyReplayDataMeta = {},
    streamGeneration = session.transportStreamGeneration
  ): void => {
    session.pendingReplayData = {
      data,
      clearBeforeReplay: meta.clearBeforeReplay !== false,
      ptyId: session.transport.getPtyId(),
      generation: (session.replayPayloadGeneration += 1),
      streamGeneration,
      ...(meta.pendingEscapeTailAnsi ? { pendingEscapeTailAnsi: meta.pendingEscapeTailAnsi } : {}),
      ...(meta.kittyKeyboardFlags !== undefined && meta.snapshotSeq !== undefined
        ? {
            kittyKeyboardFlags: meta.kittyKeyboardFlags,
            snapshotSeq: meta.snapshotSeq
          }
        : {}),
      ...(meta.terminalOwner ? { terminalOwner: meta.terminalOwner } : {}),
      ...(meta.lastTitle !== undefined ? { lastTitle: meta.lastTitle } : {}),
      ...(meta.alternateScreen !== undefined ? { alternateScreen: meta.alternateScreen } : {}),
      ...(meta.snapshotCols !== undefined && meta.snapshotRows !== undefined
        ? { snapshotCols: meta.snapshotCols, snapshotRows: meta.snapshotRows }
        : {}),
      ...(meta.carriesNormalBuffer ? { carriesNormalBuffer: true } : {}),
      ...(meta.carriesHistory ? { carriesHistory: true } : {})
    }
    session.scheduleReplayDataDrain()
  }

  bindCaptureTransportOutputCallbacks(session)
  initializeHiddenOutputRestoreState(session)
  session.setRestoredSnapshotBaseline = function (
    ptyId: string,
    snapshot: { seq?: number; pendingDeliveryStartSeq?: number },
    paintsContent: boolean
  ): void {
    if (typeof snapshot.seq !== 'number') {
      session.clearRestoredSnapshotBaseline()
      return
    }
    // Only painted cell content can back a seq baseline that permanently suppresses redelivery; blank images cannot (STA-5179).
    if (snapshot.seq > 0 && !paintsContent) {
      session.clearRestoredSnapshotBaseline()
      return
    }
    const windowStartSeq =
      typeof snapshot.pendingDeliveryStartSeq === 'number'
        ? Math.min(snapshot.pendingDeliveryStartSeq, snapshot.seq)
        : null
    if (windowStartSeq !== null && windowStartSeq >= snapshot.seq) {
      // An empty pending backlog cannot redeliver earlier seqs; arming a baseline would drop new output from restarted/foreign counters.
      session.clearRestoredSnapshotBaseline()
      return
    }
    session.restoredSnapshotBaselineSeq = snapshot.seq
    session.restoredSnapshotBaselinePtyId = ptyId
    session.restoredSnapshotExpectedStartSeq = snapshot.seq
    session.restoredSnapshotDeliveryWindowStartSeq = windowStartSeq
  }

  session.clearRestoredSnapshotBaseline = function (): void {
    session.restoredSnapshotBaselineSeq = null
    session.restoredSnapshotBaselinePtyId = null
    session.restoredSnapshotExpectedStartSeq = null
    session.restoredSnapshotDeliveryWindowStartSeq = null
  }
  session.foregroundImmediateBudget = createForegroundImmediateBudget()
  session.foregroundRewriteChunkEndedWithCarriageReturn = false
  session.foregroundRewriteCsiScanTail = ''
  session.mode2031ReplyScanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
  session.shouldSnapshotHiddenCodexOutput = shouldKeepHiddenStartupRendererQueriesLive(
    session.paneStartup
  )
  session.hiddenStartupRendererQueryPending = ''
  session.hiddenRendererStateDirty = false
  session.rendererOrderedPtyId = null
  session.rendererOrderedSeq = null
  session.rendererChannelSeqPtyId = null
  session.rendererChannelSeq = null
}
