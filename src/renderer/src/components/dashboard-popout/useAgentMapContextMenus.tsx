import { useCallback, useRef, useState } from 'react'
import type {
  DashboardSleepWorkspaceArgs,
  DashboardSpawnAgentArgs
} from '../../../../shared/dashboard-snapshot'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentMapProjectRing, AgentMapWorktreeRing } from './agent-map-layout'
import {
  AgentMapSnapshotWorkspaceMenu,
  type AgentMapSnapshotWorkspaceMenuRequest
} from './AgentMapSnapshotWorkspaceMenu'
import {
  AgentMapProjectContextMenuLoader,
  type AgentMapProjectContextMenuRequest
} from './AgentMapProjectContextMenuLoader'
import {
  AgentMapWorkspaceContextMenuLoader,
  type AgentMapWorkspaceContextMenuRequest
} from './AgentMapWorkspaceContextMenuLoader'

type UseAgentMapContextMenusArgs = {
  /** True only where the app store lives; the pop-out gets the snapshot menu. */
  enabled: boolean
  launchableAgentsByWorktreeId?: Record<string, TuiAgent[]>
  onOpenChange?: (open: boolean) => void
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  onSleepWorkspace?: (args: DashboardSleepWorkspaceArgs) => void
}

export function useAgentMapContextMenus({
  enabled,
  launchableAgentsByWorktreeId,
  onOpenChange,
  onSpawnAgent,
  onSleepWorkspace
}: UseAgentMapContextMenusArgs): {
  contextMenus: React.JSX.Element | null
  onOpenProjectContextMenu?: (
    event: React.MouseEvent<SVGCircleElement>,
    project: AgentMapProjectRing
  ) => void
  onOpenWorkspaceContextMenu?: (
    event: React.MouseEvent<SVGCircleElement>,
    worktree: AgentMapWorktreeRing
  ) => void
} {
  const requestIdRef = useRef(0)
  const [workspaceRequest, setWorkspaceRequest] =
    useState<AgentMapWorkspaceContextMenuRequest | null>(null)
  const [projectRequest, setProjectRequest] = useState<AgentMapProjectContextMenuRequest | null>(
    null
  )
  const [snapshotRequest, setSnapshotRequest] =
    useState<AgentMapSnapshotWorkspaceMenuRequest | null>(null)
  const snapshotMenuEnabled =
    !enabled && (onSpawnAgent !== undefined || onSleepWorkspace !== undefined)
  const openSnapshotWorkspaceMenu = useCallback(
    (event: React.MouseEvent<SVGCircleElement>, worktree: AgentMapWorktreeRing): void => {
      requestIdRef.current += 1
      setSnapshotRequest({
        id: requestIdRef.current,
        worktreeId: worktree.worktreeId,
        worktreeName: worktree.name,
        launchableAgents: launchableAgentsByWorktreeId?.[worktree.worktreeId] ?? [],
        clientX: event.clientX,
        clientY: event.clientY
      })
    },
    [launchableAgentsByWorktreeId]
  )
  const openWorkspaceContextMenu = useCallback(
    (event: React.MouseEvent<SVGCircleElement>, worktree: AgentMapWorktreeRing): void => {
      requestIdRef.current += 1
      setProjectRequest(null)
      setWorkspaceRequest({
        id: requestIdRef.current,
        worktreeId: worktree.worktreeId,
        executionHostId: worktree.executionHostId,
        clientX: event.clientX,
        clientY: event.clientY,
        altKey: event.altKey
      })
    },
    []
  )
  const openProjectContextMenu = useCallback(
    (event: React.MouseEvent<SVGCircleElement>, project: AgentMapProjectRing): void => {
      requestIdRef.current += 1
      setWorkspaceRequest(null)
      setProjectRequest({
        id: requestIdRef.current,
        projectId: project.id,
        clientX: event.clientX,
        clientY: event.clientY
      })
    },
    []
  )
  const handleWorkspaceLifecycleComplete = useCallback((): void => {
    setWorkspaceRequest(null)
  }, [])
  const handleProjectOpenChange = useCallback(
    (open: boolean): void => {
      onOpenChange?.(open)
      if (!open) {
        setProjectRequest(null)
      }
    },
    [onOpenChange]
  )
  const handleSnapshotOpenChange = useCallback(
    (open: boolean): void => {
      onOpenChange?.(open)
      if (!open) {
        setSnapshotRequest(null)
      }
    },
    [onOpenChange]
  )
  const contextMenus = snapshotMenuEnabled ? (
    snapshotRequest ? (
      <AgentMapSnapshotWorkspaceMenu
        request={snapshotRequest}
        onOpenChange={handleSnapshotOpenChange}
        onSpawnAgent={onSpawnAgent}
        onSleepWorkspace={onSleepWorkspace}
      />
    ) : null
  ) : enabled ? (
    <>
      {workspaceRequest ? (
        <AgentMapWorkspaceContextMenuLoader
          request={workspaceRequest}
          onOpenChange={onOpenChange}
          onLifecycleComplete={handleWorkspaceLifecycleComplete}
        />
      ) : null}
      {projectRequest ? (
        <AgentMapProjectContextMenuLoader
          request={projectRequest}
          onOpenChange={handleProjectOpenChange}
        />
      ) : null}
    </>
  ) : null

  return {
    contextMenus,
    onOpenProjectContextMenu: enabled ? openProjectContextMenu : undefined,
    onOpenWorkspaceContextMenu: enabled
      ? openWorkspaceContextMenu
      : snapshotMenuEnabled
        ? openSnapshotWorkspaceMenu
        : undefined
  }
}
