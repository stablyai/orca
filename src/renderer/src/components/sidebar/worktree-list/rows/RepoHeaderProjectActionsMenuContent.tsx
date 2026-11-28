import React from 'react'
import {
  CircleX,
  Eye,
  EyeOff,
  FolderInput,
  FolderTree,
  // `Shapes` is lucide-react's own export name; exempted in config/oxlint-anti-slop.json.
  Shapes,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getRepositoryIconSectionId } from '@/components/settings/repository/repository-settings-targets'
import { WslMoveProjectMenuItem } from '@/components/wsl-move/WslMoveProjectMenuItem'
import { WslMovedRepoUseHereMenuItem } from '@/components/wsl-move/WslMovedUseHereMenuItem'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type {
  Repo,
  WorktreeVisibilityDefaults
} from '../../../../../../shared/repository/repo-types'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'
import '../../../../../../shared/worktree/visibility/ownership'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../../../shared/worktree/visibility/external-worktree-visibility'
import { setProjectHidden } from '../../hidden-projects/set-project-hidden'
import { stopRepoHeaderMenuEvent } from './header-event-guards'
import type { RepoHeaderProjectActions } from './repo-header-project-actions'

function getWorktreeVisibilityMenuLabel(
  repo: Repo,
  visibilityDefaults?: WorktreeVisibilityDefaults,
  t: Translate = translate
): string {
  const visibility = effectiveExternalWorktreeVisibility(
    repo,
    isLegacyRepoForExternalWorktreeVisibility(repo),
    visibilityDefaults
  )
  return visibility === 'show'
    ? t(
        'auto.components.sidebar.repoHeaderProjectActions.hideNonOrcaWorktrees',
        'Hide non-Orca worktrees'
      )
    : t(
        'auto.components.sidebar.repoHeaderProjectActions.showHiddenWorktrees',
        'Show hidden worktrees'
      )
}

export function RepoHeaderProjectActionsMenuContent({
  repo,
  hostRepos,
  label,
  projectGroups,
  actions
}: {
  repo: Repo
  hostRepos?: ReadonlyMap<string, Repo>
  label: string
  projectGroups: readonly ProjectGroup[]
  actions: RepoHeaderProjectActions
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuContent
      align="end"
      side="bottom"
      sideOffset={6}
      // Why: Radix portals keep React bubbling through the project header; block menu events from arming row drag/collapse.
      onPointerDown={stopRepoHeaderMenuEvent}
      onMouseDown={stopRepoHeaderMenuEvent}
      onPointerUp={stopRepoHeaderMenuEvent}
      onMouseUp={stopRepoHeaderMenuEvent}
      onClick={stopRepoHeaderMenuEvent}
      onKeyDown={stopRepoHeaderMenuEvent}
    >
      <DropdownMenuItem onSelect={() => actions.onOpenRepoSettings(repo.id)}>
        <SlidersHorizontal className="size-3.5" />
        {t('auto.components.sidebar.WorktreeList.2cdffbc728', 'Project Settings')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => actions.onOpenRepoSettings(repo.id, getRepositoryIconSectionId(repo.id))}
      >
        <Shapes className="size-3.5" />
        {t('auto.components.sidebar.WorktreeList.e82d3589a1', 'Change Project Icon')}
      </DropdownMenuItem>
      {isGitRepoKind(repo) ? (
        <DropdownMenuItem onSelect={() => actions.onOpenWorktreeVisibility(repo)}>
          <Eye className="size-3.5" />
          {getWorktreeVisibilityMenuLabel(repo, actions.getWorktreeVisibilityDefaults(repo), t)}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={() => actions.onCreateGroupFromRepo(repo)}>
        {/* Not FolderPlus: that now means "Add project" in the sidebar header above. */}
        <FolderTree className="size-3.5" />
        {t('auto.components.sidebar.WorktreeList.cbfd565f83', 'New group from project')}
      </DropdownMenuItem>
      {projectGroups.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderInput className="size-3.5" />
            {t('auto.components.sidebar.WorktreeList.4a08fb55f2', 'Move to group')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {projectGroups.map((group) => (
              <DropdownMenuItem
                key={group.id}
                disabled={repo.projectGroupId === group.id}
                onSelect={() => actions.onMoveProjectToGroup(repo, group.id)}
              >
                <span className="max-w-48 truncate">{group.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {repo.projectGroupId ? (
        <DropdownMenuItem onSelect={() => actions.onRemoveProjectFromGroup(repo)}>
          <CircleX className="size-3.5" />
          {t('auto.components.sidebar.WorktreeList.64e55f7f01', 'Remove from group')}
        </DropdownMenuItem>
      ) : null}
      <WslMoveProjectMenuItem repo={repo} />
      <WslMovedRepoUseHereMenuItem repo={repo} />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() =>
          void setProjectHidden(hostRepos ? [...hostRepos.values()] : [repo], true, label)
        }
      >
        <EyeOff className="size-3.5" />
        {t('sidebar.hiddenProjects.hideFromSidebar', 'Hide from Sidebar')}
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onSelect={() => actions.onRemoveProject(repo)}>
        <Trash2 className="size-3.5" />
        {t('auto.components.sidebar.WorktreeList.c83968f87f', 'Remove Project')}
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}
