import { useMemo, type ReactNode } from 'react'
import { EyeOff, MoreHorizontal } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getRepoOwnerWorktreeVisibilityDefaults } from '@/store/worktree-visibility-defaults-by-host'
import { RepoHeaderProjectActionsMenu } from './worktree-list/rows/repo-header-project-actions'
import { useProjectGroupDialogs } from './worktree-list/rows/use-project-group-dialogs'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import type { ConversationProjectGroup } from './project-conversation-groups'

export function ConversationProjectMenu({
  group,
  onHide,
  children
}: {
  group: ConversationProjectGroup
  onHide?: () => void
  children?: ReactNode
}) {
  const repos = useAppStore((state) => state.repos)
  const projectGroups = useAppStore((state) => state.projectGroups)
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const dialogs = useProjectGroupDialogs({ repos, repoMap, projectGroups })
  const hide = (
    <DropdownMenuItem disabled={!onHide} onSelect={onHide}>
      <EyeOff className="size-3.5" />
      {translate('projectConversations.hideProject', 'Hide project from list')}
    </DropdownMenuItem>
  )
  if (!group.repo) {
    const label = translate(
      'projectConversations.projectOptionsFor',
      'Project options for {{project}}',
      { project: group.label }
    )
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={label}>
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">{hide}</DropdownMenuContent>
      </DropdownMenu>
    )
  }
  return (
    <>
      <RepoHeaderProjectActionsMenu
        repo={group.repo}
        label={group.label}
        projectGroups={projectGroups}
        alwaysVisible
        actions={{
          getWorktreeVisibilityDefaults: (repo) => {
            const state = useAppStore.getState()
            return getRepoOwnerWorktreeVisibilityDefaults(
              repo,
              state.settings,
              state.worktreeVisibilityDefaultsByHost
            )
          },
          onOpenRepoSettings: (repoId, sectionId) => {
            const state = useAppStore.getState()
            state.openSettingsTarget({
              pane: 'repo',
              repoId,
              hostId: group.executionHostId,
              ...(sectionId ? { sectionId } : {})
            })
            state.openSettingsPage()
          },
          onOpenWorktreeVisibility: (repo) =>
            useAppStore.getState().openModal('worktree-visibility', {
              repoId: repo.id,
              hostId: getRepoExecutionHostId(repo)
            }),
          onCreateGroupFromRepo: dialogs.handleCreateGroupFromRepo,
          onMoveProjectToGroup: dialogs.handleMoveProjectToGroup,
          onRemoveProjectFromGroup: dialogs.handleRemoveProjectFromGroup,
          onRemoveProject: (repo) =>
            useAppStore.getState().openModal('confirm-remove-folder', {
              repoId: repo.id,
              displayName: repo.displayName,
              hostId: getRepoExecutionHostId(repo)
            }),
          onCreateForRepo: (initialRepoId) =>
            useAppStore
              .getState()
              .openModal('new-workspace-composer', { initialRepoId, telemetrySource: 'sidebar' })
        }}
      >
        {children}
        {hide}
      </RepoHeaderProjectActionsMenu>
      <ProjectGroupNameDialog
        open={dialogs.nameDialog !== null}
        title={translate('auto.components.sidebar.WorktreeList.13757c053c', 'New Project Group')}
        description={translate(
          'auto.components.sidebar.WorktreeList.d880ea0744',
          'Create a group and move this project into it.'
        )}
        initialName={translate('projectConversations.defaultGroupName', '{{project}} group', {
          project: group.repo.displayName
        })}
        confirmLabel={translate('auto.components.sidebar.ProjectGroupNameDialog.create', 'Create')}
        onOpenChange={(open) => {
          if (!open) {
            dialogs.setNameDialog(null)
          }
        }}
        onSubmit={dialogs.handleSubmitProjectGroupName}
      />
    </>
  )
}
