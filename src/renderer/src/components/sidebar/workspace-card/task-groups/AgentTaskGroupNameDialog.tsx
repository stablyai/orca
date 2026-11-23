import React, { useCallback } from 'react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { ProjectGroupNameDialog } from '../../worktree-list/rows/ProjectGroupNameDialog'

export type AgentTaskGroupNameModalData = {
  workspaceKey: string
  /** Rename this group; absent creates one. */
  groupId?: string
  initialName?: string
  /** Move this conversation into the group it creates. */
  assignTabId?: string
}

function readModalData(data: Record<string, unknown>): AgentTaskGroupNameModalData | null {
  if (typeof data.workspaceKey !== 'string') {
    return null
  }
  return {
    workspaceKey: data.workspaceKey,
    ...(typeof data.groupId === 'string' ? { groupId: data.groupId } : {}),
    ...(typeof data.initialName === 'string' ? { initialName: data.initialName } : {}),
    ...(typeof data.assignTabId === 'string' ? { assignTabId: data.assignTabId } : {})
  }
}

const AgentTaskGroupNameDialog = React.memo(function AgentTaskGroupNameDialog() {
  const t = useTranslate()
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const data = readModalData(modalData)
  const isRename = Boolean(data?.groupId)

  const handleSubmit = useCallback(
    (name: string) => {
      if (!data) {
        return
      }
      const state = useAppStore.getState()
      if (data.groupId) {
        state.renameAgentTaskGroup(data.workspaceKey, data.groupId, name)
        return
      }
      const groupId = state.createAgentTaskGroup(data.workspaceKey, name)
      if (groupId && data.assignTabId) {
        state.assignTabToAgentTaskGroup(data.workspaceKey, data.assignTabId, groupId)
      }
    },
    [data]
  )

  return (
    <ProjectGroupNameDialog
      open={data !== null}
      title={
        isRename
          ? t('auto.components.sidebar.AgentTaskGroupNameDialog.renameTitle', 'Rename Task Group')
          : t('auto.components.sidebar.AgentTaskGroupNameDialog.createTitle', 'New Task Group')
      }
      description={t(
        'auto.components.sidebar.AgentTaskGroupNameDialog.description',
        'Task groups organize conversations in this workspace. They share its files and create no branch or worktree.'
      )}
      initialName={
        data?.initialName ??
        t('auto.components.sidebar.AgentTaskGroupNameDialog.defaultName', 'New Task Group')
      }
      confirmLabel={
        isRename
          ? t('auto.components.sidebar.AgentTaskGroupNameDialog.rename', 'Rename')
          : t('auto.components.sidebar.AgentTaskGroupNameDialog.create', 'Create')
      }
      onOpenChange={(open) => {
        if (!open) {
          closeModal()
        }
      }}
      onSubmit={handleSubmit}
    />
  )
})

export default AgentTaskGroupNameDialog
