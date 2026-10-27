import { useMemo, useRef } from 'react'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '../store'
import { useWorktreeMap } from '../store/selectors'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import type { WorktreeTabBucketProjection } from '@/lib/worktree-tab-bucket-projection'
import { projectWorkspaceSurfaces } from './workspace-surface-projection'
import { useReusedArrayIdentity } from './sidebar/worktree-list/listing/use-reused-array-identity'
import { usePairedRuntimeParkingEnvironmentIds } from '@/store/use-runtime-status-view'
import { createTerminalWorktreeTopologyProjection } from './terminal-pane/terminal-hidden-worktree-retention'
import { isMainTerminalSideEffectAuthorityForPty } from './terminal-pane/terminal-side-effect-facts-handler'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

export function useTerminalWorkspaceFoundation() {
  const terminalTopologyProjectionRef = useRef<WorktreeTabBucketProjection<
    TerminalTab,
    TerminalTab
  > | null>(null)
  terminalTopologyProjectionRef.current ??= createTerminalWorktreeTopologyProjection()
  const mountedWorktreeIdsRef = useRef(new Set<string>())
  const browserGuestWorktreeRecencyRef = useRef<string[]>([])
  const measurableBackgroundWorktreeIdsRef = useRef(new Set<string>())
  const terminalWorktreeHiddenSinceRef = useRef(new Map<string, number>())
  const measuringTerminalWorktreeIdsRef = useRef(new Set<string>())
  const terminalWorktreeParkCooldownUntilRef = useRef(new Map<string, number>())
  const terminalWorktreeParkingTimersRef = useRef(new Map<string, number>())
  const worktreesById = useWorktreeMap()
  const folderWorkspaces = useAppStore((state) => selectFolderWorkspaces(state))
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const renderedActiveWorktreeId = activeWorktreeId
  const activeWorktreeDeferralHostId = useAppStore((state) =>
    getResolvedExecutionHostIdForWorktree(state, renderedActiveWorktreeId)
  )
  // Only folder collision resolution needs host state; git ownership changes must not rebuild the mount projection.
  const activeFolderSurfaceHostId =
    parseWorkspaceKey(renderedActiveWorktreeId ?? '')?.type === 'folder'
      ? activeWorktreeDeferralHostId
      : null
  // Without a resolved host, active workspace cannot affect projection; omit it to avoid rebuilding every surface on switches.
  const activeFolderSurfaceId = activeFolderSurfaceHostId ? renderedActiveWorktreeId : null
  const workspaceSurfaces = useMemo(
    () =>
      projectWorkspaceSurfaces({
        worktreesById,
        folderWorkspaces,
        activeWorkspaceId: activeFolderSurfaceId,
        activeWorkspaceResolvedHostId: activeFolderSurfaceHostId
      }),
    [worktreesById, folderWorkspaces, activeFolderSurfaceId, activeFolderSurfaceHostId]
  )
  // Reuse equal ID arrays across worktree row replacements to avoid restarting mount/park effects and rebuilding their Sets.
  const workspaceSurfaceIds = useReusedArrayIdentity(
    useMemo(() => workspaceSurfaces.map((workspace) => workspace.id), [workspaceSurfaces])
  )
  const workspaceSurfaceIdSet = useMemo<ReadonlySet<string>>(
    () => new Set(workspaceSurfaceIds),
    [workspaceSurfaceIds]
  )
  const activeView = useAppStore((state) => state.activeView)
  // Root subscriptions track mount/parking transitions; LiveTerminalTabBar alone consumes title-only updates.
  const tabsByWorktree = useAppStore((state) =>
    terminalTopologyProjectionRef.current!.project(state.tabsByWorktree)
  )
  const pendingStartupByTabId = useAppStore((state) => state.pendingStartupByTabId)
  const terminalParkingEnabled = useAppStore(
    (state) => state.settings?.terminalHiddenViewParking !== false
  )
  const terminalSshParkingEnabled = useAppStore(
    (state) => state.settings?.terminalSshViewParking !== false
  )
  const pairedRuntimeParkingEnvironmentIds = usePairedRuntimeParkingEnvironmentIds()
  const terminalRetentionBudgetEnabled = useAppStore(
    (state) => state.settings?.terminalHiddenWorktreeRetentionBudget !== false
  )
  const browserGuestRetentionBudgetEnabled = useAppStore(
    (state) => state.settings?.browserGuestWorktreeRetentionBudget !== false
  )
  const terminalTitleSnapshotAuthorityEnabled = useAppStore((state) =>
    isMainTerminalSideEffectAuthorityForPty({
      settings: state.settings,
      runtimeEnvironmentId: null
    })
  )

  return {
    mountedWorktreeIdsRef,
    browserGuestWorktreeRecencyRef,
    measurableBackgroundWorktreeIdsRef,
    terminalWorktreeHiddenSinceRef,
    measuringTerminalWorktreeIdsRef,
    terminalWorktreeParkCooldownUntilRef,
    terminalWorktreeParkingTimersRef,
    folderWorkspaces,
    workspaceSurfaces,
    workspaceSurfaceIds,
    workspaceSurfaceIdSet,
    activeWorktreeId,
    renderedActiveWorktreeId,
    activeWorktreeDeferralHostId,
    activeView,
    tabsByWorktree,
    pendingStartupByTabId,
    terminalParkingEnabled,
    terminalSshParkingEnabled,
    pairedRuntimeParkingEnvironmentIds,
    terminalRetentionBudgetEnabled,
    browserGuestRetentionBudgetEnabled,
    terminalTitleSnapshotAuthorityEnabled
  }
}

export type TerminalWorkspaceFoundation = ReturnType<typeof useTerminalWorkspaceFoundation>
