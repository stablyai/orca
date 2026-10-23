import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { ClickUpTaskPageSurface } from '@/components/ClickUpTaskPageSurface'
import { normalizeTaskSourceContext } from '../../../../../shared/task-source-context'

export function TaskPageClickUpContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const { accountBackedTaskSourceHostId, fallbackTaskSourceProjectId, hideTaskSource } = model
  const clickUpStatus = useAppStore((s) => s.clickUpStatus)
  const workspaces = clickUpStatus.workspaces ?? []
  const selectedWorkspaceId =
    clickUpStatus.selectedWorkspaceId ??
    clickUpStatus.activeWorkspaceId ??
    workspaces[0]?.id ??
    null
  const selectedWorkspace =
    selectedWorkspaceId && selectedWorkspaceId !== 'all'
      ? (workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null)
      : null
  const viewerName = clickUpStatus.viewer?.username ?? null
  // Why: ClickUp is account-backed like Linear and Jira, so the source context
  // names the settings-focused host instead of a repo-owning host.
  const sourceContext = useMemo(
    () =>
      normalizeTaskSourceContext({
        provider: 'clickup',
        projectId: fallbackTaskSourceProjectId,
        hostId: accountBackedTaskSourceHostId,
        providerIdentity: {
          provider: 'clickup',
          workspaceId:
            selectedWorkspaceId && selectedWorkspaceId !== 'all' ? selectedWorkspaceId : null,
          workspaceName: selectedWorkspace?.name ?? null
        },
        accountLabel: selectedWorkspace?.name ?? viewerName
      }),
    [
      accountBackedTaskSourceHostId,
      fallbackTaskSourceProjectId,
      selectedWorkspace,
      selectedWorkspaceId,
      viewerName
    ]
  )
  return (
    <ClickUpTaskPageSurface
      sourceContext={sourceContext}
      onHide={() => hideTaskSource('clickup', 'ClickUp')}
    />
  )
}
