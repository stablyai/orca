import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { STARTUP_CWD_FALLBACK_NOTICE } from './startup-cwd-fallback-notice'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { armPaneOwnerRetry } from './pane-owner-recovery'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import { isSshSessionGoneError, recordPtyConnectDiagnostic } from './pty-connect-limits'
import { toProcessExitStartup } from './process-exit-startup'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { HeldPaneReopenOutcome } from '../newer-daemon-hold-state'
import { holdForNewerDaemon } from './newer-daemon-hold-pane'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../../shared/newer-daemon-hold'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { holdInPlaceResumeUntilSettled } from './in-place-resume-hold'

import {
  awaitAgentStatusStartupSnapshot,
  isAgentStatusStartupSnapshotReady
} from '@/hooks/ipc-events/agent-status-startup-snapshot'

const PANE_OWNER_UNVERIFIED_ERROR = 'terminal_pane_owner_unverified'
const PANE_OWNER_CHANGED_ERROR = 'terminal_pane_owner_changed'

export function startDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string
): void {
  void prepareDeferredSessionReattach(session, deferredReattachSessionId).catch(
    (error: unknown) => {
      if (!session.disposed) {
        session.reportError(error instanceof Error ? error.message : String(error))
      }
    }
  )
}

async function prepareDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string
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
  void connectDeferredSessionReattach(session, deferredReattachSessionId)
}

const NOT_REOPENED: HeldPaneReopenOutcome = { reopened: false, agentResumed: false }

/** Resolves to what the reattach did, which a held pane's release reports. */
function connectDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string
): Promise<HeldPaneReopenOutcome> {
  session.allowInitialIdleCacheSeed = true
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> REATTACH ${deferredReattachSessionId}`)

  // Why: pre-signal (declare) before the reattach connect so the cooperation gate suppresses the daemon seed for this paneKey; Electron preserves IPC order.
  // See docs/mobile-prefer-renderer-scrollback.md (Renderer-side prerequisite requirement #4).
  const preSignalPromise =
    session.runtimeEnvironmentId || isRemoteRuntimePtyId(deferredReattachSessionId)
      ? Promise.resolve(null)
      : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)

  let expiredReattachError = false
  let paneOwnerUnverified = false
  let paneOwnerChanged = false
  let heldByNewerDaemon = false
  const coldRestoreStartup = session.buildColdRestoreAgentResumeStartup()
  const outputCallbacks = session.captureTransportOutputCallbacks(
    (message) => {
      if (isSshSessionGoneError(message)) {
        expiredReattachError = true
        return
      }
      // Why local only: a paired host refuses for its own daemon, which this window cannot stop.
      if (!session.runtimeEnvironmentId && message.includes(NEWER_DAEMON_HOLD_ERROR)) {
        heldByNewerDaemon = true
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
    toProcessExitStartup(coldRestoreStartup ?? session.paneStartup)
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
    ...(coldRestoreStartup?.launchToken ? { launchToken: coldRestoreStartup.launchToken } : {}),
    ...(coldRestoreStartup?.agent ? { launchAgent: coldRestoreStartup.agent } : {}),
    ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
    callbacks: outputCallbacks.callbacks
  })
  const isCurrentReattach = (): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
    outputCallbacks.generation === session.transportStreamGeneration
  const startFreshInstead = (): Promise<HeldPaneReopenOutcome> =>
    session
      .startFreshColdRestoreAgentResume(coldRestoreStartup, { forceBlankRestoredViewport: true })
      .then(
        (ptyId: string | null) => ({
          reopened: ptyId !== null,
          agentResumed: ptyId !== null && Boolean(coldRestoreStartup)
        }),
        () => NOT_REOPENED
      )

  void Promise.resolve(reattachPromise)
    .catch(() => null)
    .finally(() => {
      session.transportConnectInFlightSince = null
    })
  const outcome = Promise.resolve(reattachPromise)
    .then(async (result): Promise<HeldPaneReopenOutcome> => {
      if (!isCurrentReattach()) {
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        const gen = await preSignalPromise
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
        return NOT_REOPENED
      }
      if (!result && heldByNewerDaemon) {
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        const gen = await preSignalPromise
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
        if (isCurrentReattach()) {
          holdForNewerDaemon(session, deferredReattachSessionId, () =>
            connectDeferredSessionReattach(session, deferredReattachSessionId)
          )
        }
        return NOT_REOPENED
      }
      if (!result && paneOwnerChanged) {
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        const gen = await preSignalPromise
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
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
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        const gen = await preSignalPromise
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
        session.settlePaneAttachAttempt('failed')
        return NOT_REOPENED
      }
      if (!result && expiredReattachError) {
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        const gen = await preSignalPromise
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
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
        outputCallbacks.generation
      )
      if (
        accepted &&
        isCurrentReattach() &&
        result &&
        typeof result === 'object' &&
        result.startupCwdFallback
      ) {
        writeTerminalOutput(session.pane.terminal, STARTUP_CWD_FALLBACK_NOTICE, {
          foreground: shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
        })
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
        agentResumed:
          accepted &&
          Boolean(coldRestoreStartup) &&
          !(result && typeof result === 'object' && result.agentResumeUnavailable)
      }
    })
    .catch(async (err): Promise<HeldPaneReopenOutcome> => {
      session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
      const gen = await preSignalPromise
      if (typeof gen === 'number') {
        void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
      }
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
  // Switch point: main clears the gone terminal's binding before this reattach's fresh start.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    holdInPlaceResumeUntilSettled(() => !session.disposed, coldRestoreStartup, outcome)
  }
  return outcome
}
