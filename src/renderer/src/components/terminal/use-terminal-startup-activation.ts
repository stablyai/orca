import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { shouldSeedDefaultSurface } from '@/lib/workspace/activation/initial-surface/automatic-default-surface'
import { findPendingWorktreeCreationId } from '@/lib/workspace/creation/pending-worktree-creation'
import { isTerminalWorkspaceEmptiedOnPurpose } from '../../../../shared/workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'
import { gateWorktreeAgentActivation } from '@/lib/workspace/activation/worktree-agent-activation-gate'
import { createWorkspaceTerminalHostAuthoritySelector } from '@/lib/workspace/ownership/workspace-terminal-host-authority'
import { hasStructuredAgentLaunchInWorktree } from '@/lib/agent-session/launch/structured-agent-session-launch-status'
import { isEmptyWorkspaceDefaultSurfacePending } from '@/lib/workspace/activation/initial-surface/empty-workspace-default-surface-claims'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { createInitialTerminalThroughLayoutOwner } from '@/store/terminals/tabs/creation/terminal-tab-create-through-layout-owner'
import type { TerminalColdActivationController } from '../terminal-cold-activation'

type TerminalStartupController = Pick<
  TerminalColdActivationController,
  | 'activeWorktreeId'
  | 'workspaceSessionReady'
  | 'terminalStartupRestorationReady'
  | 'hydrationSucceeded'
  | 'reconcileWorktreeTabModel'
  | 'createTab'
>

export function useTerminalStartupActivation(controller: TerminalStartupController): void {
  const {
    activeWorktreeId,
    workspaceSessionReady,
    terminalStartupRestorationReady,
    hydrationSucceeded,
    reconcileWorktreeTabModel,
    createTab
  } = controller
  const startupActivationGateWorktreeIdsRef = useRef(new Set<string>())
  // Subscribe so host answers rerun the passes; retain owner resolution to avoid repeating catalog walks on every store write (STA-3363).
  const hostAuthoritySelector = useMemo(
    () => createWorkspaceTerminalHostAuthoritySelector(activeWorktreeId),
    [activeWorktreeId]
  )
  const activeWorktreeHostAuthority = useAppStore(hostAuthoritySelector)
  const activeWorktreeCreationPending = useAppStore(
    (state) =>
      findPendingWorktreeCreationId(state.pendingWorktreeCreations, activeWorktreeId) !== null
  )

  useEffect(() => {
    if (
      !workspaceSessionReady ||
      !terminalStartupRestorationReady ||
      !activeWorktreeId ||
      activeWorktreeCreationPending
    ) {
      return
    }
    // An unanswered owner is not an empty host; seeding before its census duplicates tabs (STA-4658).
    if (activeWorktreeHostAuthority !== 'none') {
      return
    }
    if (startupActivationGateWorktreeIdsRef.current.has(activeWorktreeId)) {
      return
    }
    let cancelled = false
    void gateWorktreeAgentActivation(activeWorktreeId).then((outcome) => {
      if (
        cancelled ||
        outcome === 'blocked' ||
        useAppStore.getState().activeWorktreeId !== activeWorktreeId
      ) {
        return
      }
      // An in-flight reseed owns the surface but remains unmarked so leaving mid-wait allows retry on return.
      if (outcome === 'empty' && isEmptyWorkspaceDefaultSurfacePending(activeWorktreeId)) {
        return
      }
      // Only applied decisions consume the gate; canceled/blocked checks stay retryable and reruns share the in-flight promise.
      startupActivationGateWorktreeIdsRef.current.add(activeWorktreeId)
      if (outcome !== 'empty') {
        return
      }
      // A pending or unanswered chat create owns the surface even before its tab is published.
      if (hasStructuredAgentLaunchInWorktree(activeWorktreeId)) {
        return
      }
      // Why: the activation gate reconciles durable/live agent state first; only an actually empty, never-visited workspace receives a default shell.
      const { renderableTabCount } = reconcileWorktreeTabModel(activeWorktreeId)
      // Only recorded closes preserve emptiness; reread at decision time because rows can change while waiting.
      const emptiedOnPurpose = isTerminalWorkspaceEmptiedOnPurpose(
        useAppStore.getState(),
        activeWorktreeId
      )
      if (shouldSeedDefaultSurface(activeWorktreeId, renderableTabCount, emptiedOnPurpose)) {
        if (
          ORCA_LAYOUT_OWNER_IS_MAIN &&
          createInitialTerminalThroughLayoutOwner(useAppStore.getState, activeWorktreeId, () =>
            createTab(activeWorktreeId, undefined, undefined, { pendingActivationSpawn: true })
          )
        ) {
          return
        }
        // Initial default tabs must not count as user activity and reorder the sidebar; explicit New Tab still does.
        createTab(activeWorktreeId, undefined, undefined, { pendingActivationSpawn: true })
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    activeWorktreeId,
    activeWorktreeHostAuthority,
    activeWorktreeCreationPending,
    createTab,
    reconcileWorktreeTabModel,
    terminalStartupRestorationReady,
    workspaceSessionReady
  ])

  const startupResumeWorktreeIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (
      !workspaceSessionReady ||
      !terminalStartupRestorationReady ||
      !hydrationSucceeded ||
      !activeWorktreeId
    ) {
      return
    }
    if (startupResumeWorktreeIdsRef.current.has(activeWorktreeId)) {
      return
    }
    // Do not consume recovery while the host is unanswered or sleeping agents remain stranded for this session.
    if (activeWorktreeHostAuthority === 'unverifiable') {
      return
    }
    startupResumeWorktreeIdsRef.current.add(activeWorktreeId)
    // Startup recovery needs the same host census and in-flight gate as explicit activation.
    void gateWorktreeAgentActivation(activeWorktreeId).then(
      (outcome) => {
        if (outcome === 'blocked') {
          startupResumeWorktreeIdsRef.current.delete(activeWorktreeId)
        }
      },
      () => startupResumeWorktreeIdsRef.current.delete(activeWorktreeId)
    )
  }, [
    activeWorktreeId,
    activeWorktreeHostAuthority,
    hydrationSucceeded,
    terminalStartupRestorationReady,
    workspaceSessionReady
  ])
}
