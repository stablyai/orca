import { useMemo, useRef } from 'react'
import { MountedTerminalWorktrees } from '../workspace-mounting/split-group-mount'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { useAppStore } from '../../../store/index'
import { useWorktreeMap } from '../../../store/slices/worktrees/listing/use-worktree-catalog'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import type { WorktreeTabBucketProjection } from '@/lib/workspace/tabs/worktree-tab-bucket-projection'
import { projectWorkspaceSurfaces } from '../workspace-mounting/workspace-surface-projection'
import {
  parseWslMovedSurfacesKey,
  selectWslMovedSurfacesKey
} from '@/store/repos/wsl-moved-projects'
import { useReusedArrayIdentity } from '../../sidebar/worktree-list/listing/use-reused-array-identity'
import { usePairedRuntimeParkingEnvironmentIds } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { createTerminalWorktreeTopologyProjection } from '../../terminal-pane/parking/retention/terminal-hidden-worktree-retention'
import { isMainTerminalSideEffectAuthorityForPty } from '../../terminal-pane/pty-transport/output/terminal-side-effect-facts-handler'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'
import { isFloatingWorkspaceId } from '../../../../../shared/workspace/identity/floating-workspace-worktree'
import type { AppState } from '../../../store/types'

/** Activation admits detected rows the sidebar hides; without a surface the active workspace renders blank. */
function selectUnlistedActiveWorktreePath(state: AppState): string | null {
  const worktreeId = state.activeWorktreeId
  if (
    !worktreeId ||
    getIndexedWorktreeMap(selectWorktreesByRepo(state)).has(worktreeId) ||
    isFloatingWorkspaceId(worktreeId) ||
    parseWorkspaceKey(worktreeId)?.type === 'folder'
  ) {
    return null
  }
  return selectKnownWorktreeById(state, worktreeId)?.path ?? null
}

export function useTerminalWorkspaceFoundation() {
  const terminalTopologyProjectionRef = useRef<WorktreeTabBucketProjection<
    TerminalTab,
    TerminalTab
  > | null>(null)
  terminalTopologyProjectionRef.current ??= createTerminalWorktreeTopologyProjection()
  const mountedWorktreeIdsRef = useRef<Set<string>>(new MountedTerminalWorktrees())
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
  const wslMovedSurfacesKey = useAppStore(selectWslMovedSurfacesKey)
  const unlistedActivePath = useAppStore(selectUnlistedActiveWorktreePath)
  // Null while a listed workspace is active, so ordinary switches keep the projection.
  const unlistedActiveId = unlistedActivePath ? renderedActiveWorktreeId : null
  const workspaceSurfaces = useMemo(() => {
    const surfaces = projectWorkspaceSurfaces({
      worktreesById,
      folderWorkspaces,
      activeWorkspaceId: activeFolderSurfaceId,
      activeWorkspaceResolvedHostId: activeFolderSurfaceHostId
    })
    // WSL-moved chats and a hidden active worktree mount beside the catalog, which lists neither.
    const unlisted = parseWslMovedSurfacesKey(wslMovedSurfacesKey)
    if (
      unlistedActiveId &&
      unlistedActivePath &&
      !unlisted.some((surface) => surface.id === unlistedActiveId)
    ) {
      unlisted.push({ id: unlistedActiveId, path: unlistedActivePath })
    }
    return unlisted.length > 0 ? [...surfaces, ...unlisted] : surfaces
  }, [
    worktreesById,
    folderWorkspaces,
    activeFolderSurfaceId,
    activeFolderSurfaceHostId,
    wslMovedSurfacesKey,
    unlistedActiveId,
    unlistedActivePath
  ])
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
  const terminalTitleSnapshotAuthorityEnabled = useAppStore((state) =>
    isMainTerminalSideEffectAuthorityForPty({
      settings: state.settings,
      runtimeEnvironmentId: null
    })
  )

  return {
    mountedWorktreeIdsRef,
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
    terminalTitleSnapshotAuthorityEnabled
  }
}

export type TerminalWorkspaceFoundation = ReturnType<typeof useTerminalWorkspaceFoundation>
