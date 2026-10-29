import { applyTerminalLaunchResult } from './terminal-launch-result-policy'
import { armPaneOwnerRetry, isPaneOwnerRefusal } from './pane-owner-recovery'
import type { SpawnDeferralReason } from '../../../../../shared/host-spawn-admission'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { hasWorktreeTeardownStarted } from '@/store/slices/worktree-delete-state-types'
import { hasPtySerializer } from '../pty-buffer-serializer'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'

import { settleSpawnThatLeftPaneUnbound } from './unbound-pane-spawn-recovery'
import { STARTUP_CWD_FALLBACK_NOTICE } from './startup-cwd-fallback-notice'
import { pendingSpawnByPaneKey, pendingSpawnGenerationByPaneKey } from './pty-connect-limits'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { toProcessExitStartup } from './process-exit-startup'
import type {
  PendingStartupCommand,
  FreshSpawnOptions,
  ColdRestoreAgentResumeStartup
} from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { findTerminalTabForPane } from './terminal-tab-id'

export function bindStartFreshSpawn(session: ConnectPanePtySession): void {
  session.startFreshSpawn = (
    startupOverride?: PendingStartupCommand | null,
    options: FreshSpawnOptions = {}
  ): Promise<string | null> => {
    const releaseDeferredCwdFence = (): void => {
      if (!session.transport.getPtyId()) {
        // Abandoned spawns never connect; discard buffered input and settle its write promises here.
        session.transport.abandonPreconnectInput?.()
        try {
          session.deps.onDeferredCwdSpawnFailed?.()
        } catch {
          // A cleanup callback must not turn a settled spawn into an unhandled rejection.
        }
      }
    }

    if (
      hasWorktreeTeardownStarted(
        useAppStore.getState().deleteStateByWorktreeId?.[session.deps.worktreeId]
      )
    ) {
      // Worktree deletion already killed its PTYs; skip respawn into the directory being removed instead of racing main’s fence.
      releaseDeferredCwdFence()
      return Promise.resolve(null)
    }
    const effectiveStartup = startupOverride === undefined ? session.paneStartup : startupOverride
    if (effectiveStartup?.resumeSource?.cancelled) {
      releaseDeferredCwdFence()
      return Promise.resolve(null)
    }
    session.authoritativeReattachGeneration += 1
    // Every connect creates/rebinds ownership; legacy replies lacking incarnationId cannot inherit the old fence.
    session.remotePtyIncarnationId = null
    session.clearPaneMode2031State()
    session.clearHiddenOutputRestoreState()
    // Cancelled replay can retain isUserScrolling; replacement shells must start following output.
    session.resetFreshSpawnFollowOutput()
    // Fresh processes cannot inherit the previous TUI’s screen or mouse/Kitty modes.
    session.groundInputModesForNewProcess()
    session.prepareFreshShellViewportForSpawn(options)
    const coldRestoreOverride =
      startupOverride && 'launchConfig' in startupOverride
        ? (startupOverride as ColdRestoreAgentResumeStartup)
        : null
    // Declare before spawn to suppress daemon seeding; ordered Electron IPC needs no await, and the captured generation later settles/clears ownership (docs/mobile-prefer-renderer-scrollback.md).
    const preSignalPromise = session.runtimeEnvironmentId
      ? Promise.resolve(null)
      : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)
    const clearPreSignaledSerializer = (): void => {
      // Slow serializer declarations must not block successor spawns; finish disposed pre-bind cleanup independently.
      void preSignalPromise.then((gen) => {
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
      })
    }

    session.transportConnectInFlightSince = Date.now()
    session.pendingSpawnDeferral = null
    const visibleAtSpawn = session.deps.isVisibleRef.current === true
    let ownerRefused = false
    const outputCallbacks = session.captureTransportOutputCallbacks(
      (message: string) => {
        ownerRefused ||= isPaneOwnerRefusal(message)
        session.reportError(message)
      },
      toProcessExitStartup(coldRestoreOverride ?? effectiveStartup),
      coldRestoreOverride ?? effectiveStartup
    )
    const spawnedRaw = session.transport.connect({
      url: '',
      cols: session.cols,
      rows: session.rows,
      ...(startupOverride?.command ? { command: startupOverride.command } : {}),
      ...(startupOverride?.env
        ? { env: session.mergeStartupEnvWithPaneIdentity(startupOverride.env) }
        : {}),
      ...(coldRestoreOverride ? { launchConfig: coldRestoreOverride.launchConfig } : {}),
      ...(coldRestoreOverride
        ? {
            resumeProviderSession: coldRestoreOverride.resumeProviderSession,
            resumeOrigin: coldRestoreOverride.resumeOrigin
          }
        : {}),
      ...(coldRestoreOverride ? { launchToken: coldRestoreOverride.launchToken } : {}),
      ...(coldRestoreOverride ? { launchAgent: coldRestoreOverride.agent } : {}),
      ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
      // Why: a restart swaps one live session for one, and main stops the old PTY before admission.
      resumeSpawnIntent:
        visibleAtSpawn || session.userRestart ? 'user-resume' : 'automatic-restore',
      ...(session.userRestart ? { claimReplacedPtyId: session.claimPendingReplacedPtyId } : {}),
      shouldContinue: () =>
        !session.disposed &&
        (findTerminalTabForPane(useAppStore.getState(), session.deps.worktreeId, session.deps.tabId)
          ?.generation ?? 0) === session.tabGeneration,
      callbacks: outputCallbacks.callbacks
    })

    void Promise.resolve(spawnedRaw)
      .catch(() => null)
      .finally(() => {
        session.transportConnectInFlightSince = null
      })
    const trackedPromise: Promise<string | null> = Promise.resolve(spawnedRaw)
      .then(async (spawnedPtyId) => {
        if (outputCallbacks.generation !== session.transportStreamGeneration) {
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          clearPreSignaledSerializer()
          return null
        }
        const resolvedPtyId =
          spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId
            ? spawnedPtyId.id
            : typeof spawnedPtyId === 'string'
              ? spawnedPtyId
              : session.transport.getPtyId()
        const deferral: SpawnDeferralReason | null = resolvedPtyId
          ? null
          : session.pendingSpawnDeferral
        session.pendingSpawnDeferral = null
        if (deferral) {
          // Why before the launch-config cleanup below: a deferred launch is postponed, not dead.
          releaseDeferredCwdFence()
          clearPreSignaledSerializer()
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          session.enterSpawnDeferredSleep(deferral, startupOverride, options, visibleAtSpawn)
          return null
        }
        // Only the restart's deferred retries are the user's; a later wake is automatic again.
        session.userRestart = false
        const connectResult =
          spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId
            ? spawnedPtyId
            : null
        // Legacy replies may omit incarnationId; remote evidence remains unverifiable until a stamped attach result.
        session.remotePtyIncarnationId = connectResult?.incarnationId ?? null
        session.noteBoundProcessIncarnation(connectResult?.incarnationId)
        if (connectResult?.isReattach) {
          if (
            session.pendingStartupCommand?.resumeSource === effectiveStartup?.resumeSource &&
            (effectiveStartup?.resumeSource ||
              session.pendingStartupCommand?.command === effectiveStartup?.command)
          ) {
            session.pendingStartupCommand = null
          }
          const accepted = await session.handleReattachResult(
            connectResult,
            null,
            coldRestoreOverride,
            outputCallbacks.generation,
            outputCallbacks.launchContext
          )
          session.finishReattachLiveDataDeferral(accepted, outputCallbacks.generation)
          const gen = await preSignalPromise
          if (accepted && resolvedPtyId && typeof gen === 'number') {
            void window.api.pty.settlePaneSerializer(session.cacheKey, gen).catch(() => {})
          } else if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
          }
          if (!accepted) {
            // A rejected reattach ends this spawn; nothing later clears the fence.
            releaseDeferredCwdFence()
          }
          return accepted ? resolvedPtyId : null
        }
        const rejectedSavedStartup = connectResult
          ? applyTerminalLaunchResult(
              session,
              connectResult,
              outputCallbacks.launchContext,
              'creator'
            )
          : false
        const coldRestore = rejectedSavedStartup ? null : coldRestoreOverride
        if (
          connectResult?.agentResumeRefused === 'unverifiable' &&
          !(coldRestoreOverride ?? effectiveStartup)?.resumeSource?.record
        ) {
          session.keepUnrunResumeHandle(startupOverride)
        }
        if (resolvedPtyId) {
          if (
            spawnedPtyId &&
            typeof spawnedPtyId === 'object' &&
            spawnedPtyId.startupCwdFallback?.kind === 'worktree'
          ) {
            writeTerminalOutput(session.pane.terminal, STARTUP_CWD_FALLBACK_NOTICE, {
              foreground: shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
            })
          }
          if (
            spawnedPtyId &&
            typeof spawnedPtyId === 'object' &&
            spawnedPtyId.agentResumeUnavailable
          ) {
            // Dropped resume argv starts a new session; do not claim the previous session was restored.
            options.onAgentResumeUnavailable?.()
          } else if (coldRestore?.hasSleepingRecord) {
            session.showSessionRestoredBanner()
          }
          session.clearSleepingRecordAfterColdRestoreSpawn(coldRestore)
        } else if (
          session.paneStartup?.launchConfig ||
          (startupOverride && 'launchConfig' in startupOverride)
        ) {
          // Unbound spawns are no delivery target; clear launch registration so delayed drafts cannot reach a future pane.
          session.clearRegisteredStartupLaunchConfig(coldRestoreOverride ?? effectiveStartup)
        }
        if (
          resolvedPtyId &&
          spawnedPtyId &&
          typeof spawnedPtyId === 'object' &&
          'id' in spawnedPtyId &&
          session.activePanePtyBinding !== resolvedPtyId &&
          session.transport.getPtyId() === resolvedPtyId
        ) {
          // Daemon adoption can turn fresh spawn into reattach, which skips onPtySpawn to preserve recency.
          session.bindActivePanePty(resolvedPtyId, {
            updateTabPtyId: 'if-missing',
            sampleVisibleForegroundAgent: true
          })
        }
        if (resolvedPtyId) {
          session.reconcilePtySizeAfterSpawn(resolvedPtyId, session.cols, session.rows)
        }
        if (!resolvedPtyId) {
          releaseDeferredCwdFence()
          clearPreSignaledSerializer()
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          return null
        }
        const gen = await preSignalPromise
        // Bound PTYs own their serializer even after rejected declaration; generation only settles pending declaration state.
        if (resolvedPtyId) {
          if (!isRemoteRuntimePtyId(resolvedPtyId) || !hasPtySerializer(resolvedPtyId)) {
            session.registerPaneSerializerFor(resolvedPtyId)
          }
          if (typeof gen === 'number') {
            void window.api.pty.settlePaneSerializer(session.cacheKey, gen).catch(() => {})
          }
        }
        session.finishReattachLiveDataDeferral(Boolean(resolvedPtyId), outputCallbacks.generation)
        return resolvedPtyId
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!ownerRefused && isPaneOwnerRefusal(message)) {
          outputCallbacks.callbacks.onError(message)
        }
        releaseDeferredCwdFence()
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        if (
          session.paneStartup?.launchConfig ||
          (startupOverride && 'launchConfig' in startupOverride)
        ) {
          session.clearRegisteredStartupLaunchConfig(coldRestoreOverride ?? effectiveStartup)
        }
        clearPreSignaledSerializer()
        return null
      })
      .finally(() => {
        if (pendingSpawnByPaneKey.get(session.pendingSpawnKey) === trackedPromise) {
          pendingSpawnByPaneKey.delete(session.pendingSpawnKey)
          pendingSpawnGenerationByPaneKey.delete(session.pendingSpawnKey)
        }
      })
    void trackedPromise.then((spawnedPtyId) => {
      if (spawnedPtyId) {
        // Fresh-spawn recovery has no reattach settle point; report binding here so healed attempts cannot remain pending and block later recovery.
        session.settlePaneAttachAttempt?.('success')
        return
      }
      queueMicrotask(() => {
        if (
          session.disposed ||
          outputCallbacks.generation !== session.transportStreamGeneration ||
          session.transport.getPtyId() ||
          pendingSpawnByPaneKey.has(session.pendingSpawnKey)
        ) {
          return
        }
        if (ownerRefused) {
          armPaneOwnerRetry(session, outputCallbacks.generation, () =>
            session.startFreshSpawn(startupOverride, options)
          )
          session.settlePaneAttachAttempt?.('failed')
          return
        }
        if (session.deferredSpawn) {
          // Why no remount: the host would defer the remount's restore again, in a loop.
          session.settlePaneAttachAttempt?.('failed')
          return
        }
        settleSpawnThatLeftPaneUnbound(session)
      })
    })
    // Key concurrent spawns by tab and pane so a remount cannot adopt its sibling’s PTY.
    pendingSpawnByPaneKey.set(session.pendingSpawnKey, trackedPromise)
    pendingSpawnGenerationByPaneKey.set(session.pendingSpawnKey, session.tabGeneration)
    return trackedPromise
  }
}
