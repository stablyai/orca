import { useAppStore } from '@/store'
import type { PtyReplayDataMeta } from '../pty-transport'
import { INITIAL_MODE_2031_REPLY_SCAN_STATE } from '../../../../../shared/terminal-color-scheme-protocol'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { executeTerminalStartupCommandPaste } from '../terminal-startup-command-paste'
import { getTerminalPasteSshRemotePlatform } from '../terminal-paste-ssh-platform'
import { resolveTerminalPasteRuntime } from '../terminal-paste-runtime'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'

import { shouldKeepHiddenStartupRendererQueriesLive } from './hidden-startup-renderer-query'
import { createForegroundImmediateBudget } from './foreground-output-budgets'
import type { FreshSpawnOptions, ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindCaptureTransportOutputCallbacks } from './transport-output-callbacks'

import { bindReplayDataDrain } from './replay-data-drain'
import { bindStartFreshSpawn } from './fresh-spawn-start'

import { bindFreshSpawnFollowReset } from './fresh-spawn-follow-reset'

const STARTUP_DELIVERY_MAX_ATTEMPTS_PER_PTY = 5
const STARTUP_DELIVERY_MAX_REJECTION_RETRIES = 2
const STARTUP_DELIVERY_RETRY_BASE_MS = 50
const STARTUP_DELIVERY_RETRY_MAX_MS = 2_000

export function bindDeferredColdRestoreAndSnapshot(session: ConnectPanePtySession): void {
  session.applyColdRestoreAgentResumeStartup = (
    startup: ColdRestoreAgentResumeStartup | null
  ): boolean => {
    if (!startup) {
      return false
    }
    const state = useAppStore.getState()
    state.registerAgentLaunchConfig(session.cacheKey, startup.launchConfig, {
      agentType: startup.agent,
      launchToken: startup.launchToken,
      tabId: session.deps.tabId,
      leafId: session.pane.leafId
    })
    return true
  }
  session.clearSleepingRecordAfterColdRestoreSpawn = (
    startup: ColdRestoreAgentResumeStartup | null
  ): void => {
    if (startup && !startup.useLiveEntry && startup.sleepingRecordEntry) {
      session.clearSleepingRecordProviderDuplicates(
        useAppStore.getState(),
        startup.sleepingRecordEntry
      )
    }
  }
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
  session.startFreshColdRestoreAgentResume = (
    startup: ColdRestoreAgentResumeStartup | null = session.buildColdRestoreAgentResumeStartup(),
    options: FreshSpawnOptions = {}
  ): Promise<string | null> => {
    session.applyColdRestoreAgentResumeStartup(startup)
    return session.startFreshSpawn(startup, options)
  }
  // Why: the hibernation wake fires from noteVisibilityResume in the outer
  // connection scope, long after this deferred-connect closure has run.
  session.wakeHibernatedAgentPane = () => session.startFreshColdRestoreAgentResume()
  const isStartupPasteTargetCurrent = (ptyId: string | null): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
    session.transport.getPtyId() === ptyId
  const runTerminalPasteStartupCommand = async (
    command: string,
    submit: boolean | undefined
  ): Promise<{ delivered: boolean; partial: boolean }> => {
    const ptyId = session.transport.getPtyId()
    const result = await executeTerminalStartupCommandPaste({
      command,
      submit,
      pane: session.pane,
      ptyId,
      runtime: resolveTerminalPasteRuntime({
        platform: CLIENT_PLATFORM,
        ptyId,
        connectionId: session.connectionId,
        remotePlatform: getTerminalPasteSshRemotePlatform(session.connectionId),
        transport: session.transport,
        isWindowsConpty: session.isNativeWindowsConpty
      }),
      transport: session.transport,
      isTargetCurrent: isStartupPasteTargetCurrent
    })
    if (result.status !== 'pasted' || !isStartupPasteTargetCurrent(ptyId)) {
      return { delivered: false, partial: result.chunksWritten > 0 }
    }
    return {
      delivered: true,
      partial: false
    }
  }
  let startupDeliveryInFlight = false
  let startupDeliveryRetryRequested = false
  let startupDeliveryAttemptPtyId: string | null = null
  let startupDeliveryAttempts = 0
  let startupDeliveryRejectionRetries = 0
  const scheduleStartupDeliveryAttempt = (): void => {
    const startup = session.pendingStartupCommand
    if (!startup) {
      return
    }
    const currentPtyId = session.transport.getPtyId()
    if (currentPtyId !== startupDeliveryAttemptPtyId) {
      startupDeliveryAttemptPtyId = currentPtyId
      startupDeliveryAttempts = 0
    }
    if (startupDeliveryAttempts >= STARTUP_DELIVERY_MAX_ATTEMPTS_PER_PTY) {
      return
    }
    if (startupDeliveryInFlight) {
      startupDeliveryRetryRequested = true
      return
    }
    if (session.startupInjectTimer !== null) {
      clearTimeout(session.startupInjectTimer)
    }
    session.startupInjectTimer = setTimeout(
      () => {
        session.startupInjectTimer = null
        void (async () => {
          if (startupDeliveryInFlight) {
            startupDeliveryRetryRequested = true
            return
          }
          startupDeliveryInFlight = true
          startupDeliveryRetryRequested = false
          startupDeliveryAttempts += 1
          try {
            if (session.pendingStartupCommand !== startup || session.disposed) {
              return
            }
            if (session.shouldDeliverStartupViaTerminalPaste) {
              await waitForTerminalOutputParsed(session.pane.terminal)
            }
            if (session.pendingStartupCommand !== startup || session.disposed) {
              return
            }
            const command = startup.command
            let outcome = { delivered: false, partial: false }
            try {
              outcome = session.shouldDeliverStartupViaTerminalPaste
                ? await runTerminalPasteStartupCommand(command, startup.submit)
                : {
                    delivered:
                      startup.submit === false
                        ? session.transport.sendInput(command)
                        : session.transport.sendInput(`${command}\r`),
                    partial: false
                  }
            } catch {
              outcome = { delivered: false, partial: false }
            }
            if (outcome.delivered) {
              session.armStartupDraftReadinessObservation()
              try {
                session.deps.onQueuedStartupDelivered?.()
              } catch {
                // Do not invalidate a completed paste because queue cleanup failed.
              }
              if (session.pendingStartupCommand === startup) {
                session.pendingStartupCommand = null
              }
            } else {
              if (outcome.partial) {
                startupDeliveryAttempts = STARTUP_DELIVERY_MAX_ATTEMPTS_PER_PTY
              } else if (startupDeliveryRejectionRetries < STARTUP_DELIVERY_MAX_REJECTION_RETRIES) {
                // Why: a zero-write rejection leaves the command pending, and a
                // quiet shell emits no further output to re-trigger delivery.
                startupDeliveryRejectionRetries += 1
                startupDeliveryRetryRequested = true
              }
              session.releaseUnattemptedStartupDraftPasteDelivery()
            }
          } finally {
            startupDeliveryInFlight = false
            if (
              startupDeliveryRetryRequested &&
              session.pendingStartupCommand === startup &&
              !session.disposed
            ) {
              scheduleStartupDeliveryAttempt()
            }
          }
        })()
      },
      Math.min(
        STARTUP_DELIVERY_RETRY_BASE_MS * 2 ** startupDeliveryAttempts,
        STARTUP_DELIVERY_RETRY_MAX_MS
      )
    )
  }
  // Why: an external trigger is fresh evidence the pane may accept input now,
  // so rejection retries start a new chain instead of staying exhausted.
  session.schedulePendingStartupCommandDelivery = (): void => {
    startupDeliveryRejectionRetries = 0
    scheduleStartupDeliveryAttempt()
  }

  session.freshSpawnFollowResetDisposables = []
  session.cancelFreshSpawnFollowReset = (): void => {
    for (const disposable of session.freshSpawnFollowResetDisposables) {
      disposable.dispose()
    }
    session.freshSpawnFollowResetDisposables = []
  }
  bindFreshSpawnFollowReset(session)
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
      ...(meta.alternateScreen !== undefined ? { alternateScreen: meta.alternateScreen } : {})
    }
    session.scheduleReplayDataDrain()
  }

  bindCaptureTransportOutputCallbacks(session)
  session.setRestoredSnapshotBaseline = function (
    ptyId: string,
    snapshot: { seq?: number; pendingDeliveryStartSeq?: number },
    paintsContent: boolean
  ): void {
    if (typeof snapshot.seq !== 'number') {
      session.clearRestoredSnapshotBaseline()
      return
    }
    // Why: arming drops the redelivery permanently, so the snapshot's painted
    // content must be able to back the seq it claims; a blank image cannot (STA-5179).
    if (snapshot.seq > 0 && !paintsContent) {
      session.clearRestoredSnapshotBaseline()
      return
    }
    const windowStartSeq =
      typeof snapshot.pendingDeliveryStartSeq === 'number'
        ? Math.min(snapshot.pendingDeliveryStartSeq, snapshot.seq)
        : null
    if (windowStartSeq !== null && windowStartSeq >= snapshot.seq) {
      // Why: main reported an empty undelivered backlog — no chunk at or
      // below the snapshot seq can ever arrive again (delivery is once and
      // in order) and a future pending-cap trim re-arms the out-of-band
      // marker. Arming a baseline anyway would misread live chunks from a
      // foreign seq domain (restarted counter / synthetic injection) as
      // duplicates or trim gaps and silently drop genuinely-new output.
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
