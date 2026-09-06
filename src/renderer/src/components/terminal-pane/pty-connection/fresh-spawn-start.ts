import { useAppStore } from '@/store'
import { hasPtySerializer } from '../pty-buffer-serializer'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'

import { STARTUP_CWD_FALLBACK_NOTICE } from './startup-cwd-fallback-notice'
import { pendingSpawnByPaneKey, pendingSpawnGenerationByPaneKey } from './pty-connect-limits'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { toProcessExitStartup } from './process-exit-startup'
import type {
  PendingStartupCommand,
  FreshSpawnOptions,
  ColdRestoreAgentResumeStartup
} from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { resolveTerminalTabId } from './terminal-tab-id'

export function bindStartFreshSpawn(session: ConnectPanePtySession): void {
  session.startFreshSpawn = (
    startupOverride?: PendingStartupCommand | null,
    options: FreshSpawnOptions = {}
  ): Promise<string | null> => {
    const releaseDeferredCwdFence = (): void => {
      if (!session.transport.getPtyId()) {
        // An abandoned spawn never reaches connect(), so nothing else would ever
        // drain the pre-connect buffer or settle its acknowledged-write promises.
        session.transport.abandonPreconnectInput?.()
        try {
          session.deps.onDeferredCwdSpawnFailed?.()
        } catch {
          // A cleanup callback must not turn a settled spawn into an unhandled rejection.
        }
      }
    }
    if (session.isLegacyWorkerAutomaticResumeBlocked()) {
      releaseDeferredCwdFence()
      return Promise.resolve(null)
    }
    if (useAppStore.getState().deleteStateByWorktreeId?.[session.deps.worktreeId]?.isDeleting) {
      // Why: the worktree is being deleted; its PTYs were just killed for the
      // filesystem teardown. A fresh shell must not spawn into a directory the
      // removal is about to delete (main fences it anyway), and the pane is
      // about to unmount — so skip the doomed respawn instead of racing it.
      releaseDeferredCwdFence()
      return Promise.resolve(null)
    }
    session.authoritativeReattachGeneration += 1
    // Every fresh connect creates or rebinds a PTY. Do not let a legacy
    // response that omits `incarnationId` inherit the predecessor's fence.
    session.remotePtyIncarnationId = null
    session.clearPaneMode2031State()
    session.clearHiddenOutputRestoreState()
    // Why: a canceled old replay clear can preserve xterm's native
    // isUserScrolling flag. A replacement shell must start in follow mode.
    session.resetFreshSpawnFollowOutput()
    // Why: a fresh spawn is a new process with kitty keyboard flags at
    // zero. The exit-handler reset alone is not enough: a late exit from a
    // replaced PTY takes the stale-transport early return and skips it, so
    // a restart-in-place would leak the old TUI's flags into a fresh shell.
    session.kittyKeyboardModes.reset()
    session.prepareFreshShellViewportForSpawn(options)
    const coldRestoreOverride =
      startupOverride && 'launchConfig' in startupOverride
        ? (startupOverride as ColdRestoreAgentResumeStartup)
        : null
    // Why: pre-signal the main process so its cooperation gate suppresses
    // the daemon-snapshot seed for this paneKey. We issue declare and the
    // spawn back-to-back without awaiting, because Electron's
    // ipcRenderer→ipcMain channel preserves order across consecutive invoke
    // calls from the same renderer. The cooperation gate at pty:spawn time
    // sees pendingByPaneKey populated. Settle/clear later echoes the gen
    // token captured here. See docs/mobile-prefer-renderer-scrollback.md.
    const preSignalPromise = session.runtimeEnvironmentId
      ? Promise.resolve(null)
      : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)
    const clearPreSignaledSerializer = (): void => {
      // A disposed pre-bind connect must not keep a successor behind a slow
      // serializer declaration. Cleanup can finish independently of spawn ownership.
      void preSignalPromise.then((gen) => {
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
      })
    }

    session.transportConnectInFlightSince = Date.now()
    const effectiveStartup = startupOverride === undefined ? session.paneStartup : startupOverride
    const outputCallbacks = session.captureTransportOutputCallbacks(
      session.reportError,
      toProcessExitStartup(coldRestoreOverride ?? effectiveStartup)
    )
    const spawnedRaw = session.transport.connect({
      url: '',
      cols: session.cols,
      rows: session.rows,
      ...(startupOverride?.command ? { command: startupOverride.command } : {}),
      ...(session.connectionId &&
      startupOverride?.command &&
      !session.shouldDeliverStartupViaTerminalPaste
        ? { commandDelivery: 'provider' as const }
        : {}),
      ...(session.connectionId && startupOverride?.command
        ? { startupCommandDelivery: 'shell-ready' as const }
        : {}),
      ...(startupOverride?.env
        ? { env: session.mergeStartupEnvWithPaneIdentity(startupOverride.env) }
        : {}),
      ...(coldRestoreOverride ? { launchConfig: coldRestoreOverride.launchConfig } : {}),
      ...(coldRestoreOverride
        ? { resumeProviderSession: coldRestoreOverride.resumeProviderSession }
        : {}),
      ...(coldRestoreOverride ? { launchToken: coldRestoreOverride.launchToken } : {}),
      ...(coldRestoreOverride ? { launchAgent: coldRestoreOverride.agent } : {}),
      ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
      shouldContinue: () => {
        const state = useAppStore.getState()
        const unifiedTab = state.getTab?.(session.deps.tabId)
        const initialOwnerWorktreeId =
          state.getTerminalTabOwnerWorktreeId?.(session.deps.tabId) ??
          (unifiedTab?.contentType === 'terminal'
            ? state.getTerminalTabOwnerWorktreeId?.(unifiedTab.entityId)
            : null)
        const terminalTabId = resolveTerminalTabId(
          {
            getTab: state.getTab,
            hasTerminalTab: (candidateId) =>
              Boolean(
                state.tabsByWorktree[session.deps.worktreeId]?.some(
                  (candidate) => candidate.id === candidateId
                ) ||
                (initialOwnerWorktreeId
                  ? state.tabsByWorktree[initialOwnerWorktreeId]?.some(
                      (candidate) => candidate.id === candidateId
                    )
                  : false)
              )
          },
          session.deps.tabId
        )
        const ownerWorktreeId =
          state.getTerminalTabOwnerWorktreeId?.(terminalTabId) ?? initialOwnerWorktreeId
        const terminalTab =
          state.tabsByWorktree[session.deps.worktreeId]?.find(
            (candidate) => candidate.id === terminalTabId
          ) ??
          (ownerWorktreeId
            ? state.tabsByWorktree[ownerWorktreeId]?.find(
                (candidate) => candidate.id === terminalTabId
              )
            : undefined)
        const fallbackTab = Object.values(state.tabsByWorktree)
          .find((tabs) => tabs.some((candidate) => candidate.id === terminalTabId))
          ?.find((candidate) => candidate.id === terminalTabId)
        const currentTab =
          terminalTab ??
          fallbackTab ??
          (unifiedTab && 'generation' in unifiedTab ? unifiedTab : null)
        return !session.disposed && (currentTab?.generation ?? 0) === session.tabGeneration
      },
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
        if (resolvedPtyId && !session.claimCapturedDirectSshRetryPty(resolvedPtyId)) {
          releaseDeferredCwdFence()
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          // Why: an outstanding declare keeps main's cooperation gate suppressing
          // this paneKey's daemon-snapshot seed until something releases it.
          clearPreSignaledSerializer()
          return null
        }
        const connectResult =
          spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId
            ? spawnedPtyId
            : null
        // Old hosts may return a string or an object without the optional
        // field; either way remote evidence must remain client-only
        // unverifiable until a stamped attach result arrives.
        session.remotePtyIncarnationId = connectResult?.incarnationId ?? null
        if (connectResult?.isReattach) {
          session.pendingStartupCommand = null
          const accepted = await session.handleReattachResult(
            connectResult,
            null,
            coldRestoreOverride,
            outputCallbacks.generation
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
        if (spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId) {
          session.registerEffectiveLaunchConfig(spawnedPtyId.launchConfig, {
            ...(coldRestoreOverride ? { launchToken: coldRestoreOverride.launchToken } : {}),
            ...(coldRestoreOverride ? { launchAgent: coldRestoreOverride.agent } : {})
          })
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
            // Why: main dropped the resume argv, so this pane is a NEW session —
            // the plain restored banner would claim the old one came back.
            session.showSessionRestoredBanner('resume-unavailable')
          } else if (coldRestoreOverride?.hasSleepingRecord) {
            session.showSessionRestoredBanner()
          }
          session.clearSleepingRecordAfterColdRestoreSpawn(coldRestoreOverride)
        } else if (
          session.paneStartup?.launchConfig ||
          (startupOverride && 'launchConfig' in startupOverride)
        ) {
          // Why: delayed draft/follow-up delivery keys off this launch
          // registry. If spawn produced no PTY, the launch is no longer a
          // viable delivery target and must not wait for a future pane.
          session.clearRegisteredStartupLaunchConfig()
        }
        if (
          resolvedPtyId &&
          spawnedPtyId &&
          typeof spawnedPtyId === 'object' &&
          'id' in spawnedPtyId &&
          session.activePanePtyBinding !== resolvedPtyId &&
          session.transport.getPtyId() === resolvedPtyId
        ) {
          // Why: daemon createOrAttach can turn an apparent fresh spawn into
          // a reattach; the transport skips onPtySpawn there to preserve recency.
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
        // Why: a bound PTY owns the renderer serializer even when the declare was
        // rejected; the gen token only settles or clears the pending declaration.
        if (resolvedPtyId) {
          if (!isRemoteRuntimePtyId(resolvedPtyId) || !hasPtySerializer(resolvedPtyId)) {
            session.registerPaneSerializerFor(resolvedPtyId)
          }
          if (typeof gen === 'number') {
            void window.api.pty.settlePaneSerializer(session.cacheKey, gen).catch(() => {})
          }
        }
        if (resolvedPtyId && session.connectionId) {
          if (
            session.shouldUseProviderSshStartupDelivery &&
            (startupOverride?.command || session.paneStartup?.command)
          ) {
            session.armStartupDraftReadinessObservation()
          }
          session.schedulePendingStartupCommandDelivery()
        }
        session.finishReattachLiveDataDeferral(Boolean(resolvedPtyId), outputCallbacks.generation)
        return resolvedPtyId
      })
      .catch(async () => {
        releaseDeferredCwdFence()
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        if (
          session.paneStartup?.launchConfig ||
          (startupOverride && 'launchConfig' in startupOverride)
        ) {
          session.clearRegisteredStartupLaunchConfig()
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
    session.armDirectSshPaneRetryTimeout(trackedPromise, session.directSshRetryAttempt)
    void trackedPromise.then((spawnedPtyId) => {
      if (spawnedPtyId) {
        return
      }
      queueMicrotask(() => {
        if (
          session.disposed ||
          session.transport.getPtyId() ||
          pendingSpawnByPaneKey.has(session.pendingSpawnKey)
        ) {
          return
        }
        session.settleDirectSshPaneRetryAttempt(session.directSshRetryAttempt, 'failed')
      })
    })
    // Why: split panes in the same tab can spawn concurrently. Key by pane
    // as well as tab so a remount cannot attach to a sibling setup pane's PTY.
    pendingSpawnByPaneKey.set(session.pendingSpawnKey, trackedPromise)
    pendingSpawnGenerationByPaneKey.set(session.pendingSpawnKey, session.tabGeneration)
    return trackedPromise
  }
}
