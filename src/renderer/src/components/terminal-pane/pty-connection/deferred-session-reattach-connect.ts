import { NOT_REOPENED, reopenPaneAfterMissingReattach } from './cold-restore-resume-startup'
import { writeStartupCwdFallbackNotice } from './startup-cwd-fallback-notice'
import { armPaneOwnerRetry } from './pane-owner-recovery'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import { isSshSessionGoneError, recordPtyConnectDiagnostic } from './pty-connect-limits'
import { toProcessExitStartup } from './process-exit-startup'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { HeldPaneReopenOutcome } from '../newer-daemon-hold-state'
import { holdForNewerDaemon } from './newer-daemon-hold-pane'
import { holdForStoppedWslDistro, wslRestoreStartArgs } from './wsl-distro-stopped-hold-pane'
import { parseWslDistroHold } from '../../../../../shared/wsl-distro-stopped-hold'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../../shared/newer-daemon-hold'
import { PANE_NOT_LIVE_ERROR } from '../../../../../shared/pane-attach-only-view'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { holdInPlaceResumeUntilSettled } from './in-place-resume-hold'
import { mainStartsPane, startMainPaneOnFirstView } from './main-starts-pane'
import { attachResumeCheck } from './main-pane-resume-banner'

import {
  awaitAgentStatusStartupSnapshot,
  isAgentStatusStartupSnapshotReady
} from '@/hooks/ipc-events/agent-status-startup-snapshot'

const PANE_OWNER_UNVERIFIED_ERROR = 'terminal_pane_owner_unverified'
const PANE_OWNER_CHANGED_ERROR = 'terminal_pane_owner_changed'

/** Layout-owner build: `afterMainStart` attaches to the terminal main just started for the pane. */
type ReattachOptions = { afterMainStart?: true; userAct?: true }

export function startDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string,
  options: ReattachOptions = {}
): void {
  void prepareDeferredSessionReattach(session, deferredReattachSessionId, options).catch(
    (error: unknown) => {
      if (!session.disposed) {
        session.reportError(error instanceof Error ? error.message : String(error))
      }
    }
  )
}

async function prepareDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string,
  options: ReattachOptions
): Promise<void> {
  const generation = session.transportStreamGeneration
  let waitedForSnapshot = false
  if (
    !session.runtimeEnvironmentId &&
    !session.buildColdRestoreAgentResumeStartup() &&
    !isAgentStatusStartupSnapshotReady()
  ) {
    waitedForSnapshot = true
    await awaitAgentStatusStartupSnapshot()
  }
  if (
    session.disposed ||
    generation !== session.transportStreamGeneration ||
    (waitedForSnapshot &&
      session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport)
  ) {
    return
  }
  void connectDeferredSessionReattach(session, deferredReattachSessionId, options)
}

/** Resolves to what the reattach did, which a held pane's release reports. */
function connectDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string,
  options: ReattachOptions = {}
): Promise<HeldPaneReopenOutcome> {
  // Why: while this attach runs, a fallback that would ask main to start again is refused instead.
  const mainStartAttach = options.afterMainStart ? {} : null
  session.mainStartAttach = mainStartAttach
  session.allowInitialIdleCacheSeed = true
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> REATTACH ${deferredReattachSessionId}`)

  // Declare before connect; Electron’s ordered IPC suppresses daemon seeding before reattach (docs/mobile-prefer-renderer-scrollback.md, prerequisite #4).
  const preSignalPromise =
    session.runtimeEnvironmentId || isRemoteRuntimePtyId(deferredReattachSessionId)
      ? Promise.resolve(null)
      : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)

  let expiredReattachError = false
  let paneNotLive = false
  let paneOwnerUnverified = false
  let paneOwnerChanged = false
  let heldByNewerDaemon = false
  let heldForStoppedDistro: ReturnType<typeof parseWslDistroHold> = null
  // Why: main started this pane's agent; the window's attach never resumes it a second time.
  const attachOnlyView = mainStartsPane(session)
  const resumeStartup = session.buildColdRestoreAgentResumeStartup()
  const coldRestoreStartup = attachOnlyView ? null : resumeStartup
  const resumedAgent = attachResumeCheck(session, coldRestoreStartup)
  const outputCallbacks = session.captureTransportOutputCallbacks(
    (message) => {
      if (isSshSessionGoneError(message)) {
        expiredReattachError = true
        return
      }
      if (message.includes(PANE_NOT_LIVE_ERROR)) {
        paneNotLive = true
        return
      }
      // Why local only: a paired host refuses for its own daemon, which this window cannot stop.
      if (!session.runtimeEnvironmentId && message.includes(NEWER_DAEMON_HOLD_ERROR)) {
        heldByNewerDaemon = true
        return
      }
      heldForStoppedDistro ??= session.runtimeEnvironmentId ? null : parseWslDistroHold(message)
      if (heldForStoppedDistro) {
        return
      }
      if (message.includes(PANE_OWNER_UNVERIFIED_ERROR)) {
        paneOwnerUnverified = true
      }
      if (message.includes(PANE_OWNER_CHANGED_ERROR)) {
        paneOwnerChanged = true
      }
      session.reportError(message)
    },
    // Why the resume even under main: it is what main ran, so a capacity retry resumes it again.
    toProcessExitStartup(resumeStartup ?? session.paneStartup),
    resumeStartup ?? session.paneStartup
  )
  session.beginReattachLiveDataDeferral(outputCallbacks.generation)
  session.transportConnectInFlightSince = Date.now()
  const reattachPromise = session.transport.connect({
    url: '',
    cols: session.cols,
    rows: session.rows,
    sessionId: deferredReattachSessionId,
    ...(coldRestoreStartup?.command ? { command: coldRestoreStartup.command } : {}),
    ...(coldRestoreStartup?.env
      ? { env: session.mergeStartupEnvWithPaneIdentity(coldRestoreStartup.env) }
      : {}),
    ...(coldRestoreStartup?.launchConfig ? { launchConfig: coldRestoreStartup.launchConfig } : {}),
    ...(coldRestoreStartup?.resumeProviderSession
      ? { resumeProviderSession: coldRestoreStartup.resumeProviderSession }
      : {}),
    ...(coldRestoreStartup ? { resumeOrigin: coldRestoreStartup.resumeOrigin } : {}),
    ...(coldRestoreStartup?.launchToken ? { launchToken: coldRestoreStartup.launchToken } : {}),
    ...(coldRestoreStartup?.agent ? { launchAgent: coldRestoreStartup.agent } : {}),
    ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
    ...(attachOnlyView ? { attachOnlyView: true as const } : {}),
    ...wslRestoreStartArgs(session, options.userAct === true),
    callbacks: outputCallbacks.callbacks
  })
  const isCurrentReattach = (): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
    outputCallbacks.generation === session.transportStreamGeneration
  // A reattach that did not take: drop the serializer this pane declared for it.
  const abandonPendingSerializer = async (): Promise<void> => {
    session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
    const gen = await preSignalPromise
    if (typeof gen === 'number') {
      void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
    }
  }
  const startFreshInstead = (): Promise<HeldPaneReopenOutcome> =>
    reopenPaneAfterMissingReattach(session, coldRestoreStartup, resumedAgent)

  void Promise.resolve(reattachPromise)
    .catch(() => null)
    .finally(() => {
      session.transportConnectInFlightSince = null
    })
  const outcome = Promise.resolve(reattachPromise)
    .then(async (result): Promise<HeldPaneReopenOutcome> => {
      if (!isCurrentReattach()) {
        await abandonPendingSerializer()
        return NOT_REOPENED
      }
      if (!result && (heldByNewerDaemon || heldForStoppedDistro)) {
        await abandonPendingSerializer()
        if (isCurrentReattach() && heldForStoppedDistro) {
          // Start is the user's act: this reconnect may start the distro.
          holdForStoppedWslDistro(session, deferredReattachSessionId, heldForStoppedDistro, () =>
            connectDeferredSessionReattach(session, deferredReattachSessionId, { userAct: true })
          )
        } else if (isCurrentReattach()) {
          holdForNewerDaemon(session, deferredReattachSessionId, () =>
            connectDeferredSessionReattach(session, deferredReattachSessionId)
          )
        }
        return NOT_REOPENED
      }
      if (!result && paneOwnerChanged) {
        await abandonPendingSerializer()
        armPaneOwnerRetry(session, outputCallbacks.generation, () =>
          connectDeferredSessionReattach(session, deferredReattachSessionId)
        )
        session.settlePaneAttachAttempt('failed')
        return NOT_REOPENED
      }
      if (!result && paneOwnerUnverified) {
        armPaneOwnerRetry(session, outputCallbacks.generation, () =>
          connectDeferredSessionReattach(session, deferredReattachSessionId)
        )
        await abandonPendingSerializer()
        session.settlePaneAttachAttempt('failed')
        return NOT_REOPENED
      }
      if (!result && paneNotLive) {
        await abandonPendingSerializer()
        if (!isCurrentReattach()) {
          return NOT_REOPENED
        }
        if (!session.deps.isVisibleRef.current) {
          startMainPaneOnFirstView(session, () => void startFreshInstead())
          return NOT_REOPENED
        }
        // Why the binding stays: main's start reuses its id, which carries the terminal's history.
        return startFreshInstead()
      }
      if (!result && expiredReattachError) {
        await abandonPendingSerializer()
        if (!isCurrentReattach()) {
          return NOT_REOPENED
        }
        session.clearExitedPanePtyLayoutBinding(deferredReattachSessionId)
        session.deps.clearTabPtyId(session.deps.tabId, deferredReattachSessionId)
        return startFreshInstead()
      }
      const accepted = await session.handleReattachResult(
        result,
        deferredReattachSessionId,
        coldRestoreStartup,
        outputCallbacks.generation,
        outputCallbacks.launchContext
      )
      if (accepted && isCurrentReattach()) {
        writeStartupCwdFallbackNotice(session, result)
      }
      session.finishReattachLiveDataDeferral(accepted, outputCallbacks.generation)
      const gen = await preSignalPromise
      if (typeof gen === 'number') {
        if (!accepted) {
          await window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        } else if (!isRemoteRuntimePtyId(deferredReattachSessionId)) {
          const settledPtyId =
            result && typeof result === 'object' && 'id' in result
              ? result.id
              : (session.transport.getPtyId() ?? deferredReattachSessionId)
          const hasRestorePayload =
            result &&
            typeof result === 'object' &&
            ('snapshot' in result || 'replay' in result || 'coldRestore' in result)
          await (hasRestorePayload
            ? session.settlePaneSerializerAfterReplay(settledPtyId, gen)
            : window.api.pty.settlePaneSerializer(session.cacheKey, gen))
        }
      }
      return {
        reopened: accepted,
        agentResumed: accepted && resumedAgent(deferredReattachSessionId, result)
      }
    })
    .catch(async (err): Promise<HeldPaneReopenOutcome> => {
      await abandonPendingSerializer()
      const message = err instanceof Error ? err.message : String(err)
      if (!isCurrentReattach()) {
        return NOT_REOPENED
      }
      if (
        message.includes(PANE_OWNER_UNVERIFIED_ERROR) ||
        message.includes(PANE_OWNER_CHANGED_ERROR)
      ) {
        outputCallbacks.callbacks.onError(message)
        armPaneOwnerRetry(session, outputCallbacks.generation, () =>
          connectDeferredSessionReattach(session, deferredReattachSessionId)
        )
        session.settlePaneAttachAttempt('failed')
        return NOT_REOPENED
      }
      warnTerminalLifecycleAnomaly('restored PTY reattach threw', {
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        leafId: session.deps.restoredLeafId ?? session.pane.leafId,
        paneId: session.pane.id,
        ptyId: deferredReattachSessionId,
        reason: message
      })
      session.reportError(message)
      session.clearExitedPanePtyLayoutBinding(deferredReattachSessionId)
      session.deps.clearTabPtyId(session.deps.tabId, deferredReattachSessionId)
      return startFreshInstead()
    })
  void outcome.finally(() => {
    if (session.mainStartAttach === mainStartAttach) {
      session.mainStartAttach = null
    }
  })
  // Switch point: main clears the gone terminal's binding before this reattach's fresh start.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    holdInPlaceResumeUntilSettled(() => !session.disposed, coldRestoreStartup, outcome)
  }
  return outcome
}
