import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import type { TaskPageRuntimeHostsModel } from '../use-task-page-runtime-hosts'

/** ClickUp connection facts the Tasks page chrome needs before any list loads. */
export function useTaskPageClickUpConnection(model: TaskPageRuntimeHostsModel) {
  const { providerRuntimeContextKey } = model
  const clickupStatus = useAppStore((s) => s.clickupStatus)
  const clickupStatusChecked = useAppStore((s) => s.clickupStatusChecked)
  const clickupStatusContextKey = useAppStore((s) => s.clickupStatusContextKey)
  const clickupConnectionLost = useAppStore((s) => s.clickupConnectionLost)
  const checkClickUpConnection = useAppStore((s) => s.checkClickUpConnection)
  const clickupStatusCurrent = clickupStatusContextKey === providerRuntimeContextKey
  const clickupStatusReady = clickupStatusCurrent && clickupStatusChecked
  const clickupConnected = clickupStatusCurrent && clickupStatus.connected
  const clickupWorkspaces = clickupStatus.workspaces
  const selectedClickUpWorkspace = useMemo(
    () =>
      clickupWorkspaces.find((workspace) => workspace.id === clickupStatus.selectedWorkspaceId) ??
      clickupWorkspaces[0] ??
      null,
    [clickupStatus.selectedWorkspaceId, clickupWorkspaces]
  )
  return Object.assign(model, {
    clickupStatus,
    clickupStatusReady,
    clickupConnected,
    clickupConnectionLost,
    clickupWorkspaces,
    selectedClickUpWorkspace,
    checkClickUpConnection
  })
}
export type TaskPageClickUpConnectionModel = ReturnType<typeof useTaskPageClickUpConnection>
