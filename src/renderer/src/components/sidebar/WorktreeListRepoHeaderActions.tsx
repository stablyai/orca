import {
  CircleX,
  Ellipsis,
  Eye,
  FolderInput,
  FolderPlus,
  Plus,
  Shapes,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import type { ProjectGroup, Repo } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getRepositoryIconSectionId } from '@/components/settings/repository-settings-targets'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { RepoHeaderCreateState } from './repo-header-create-state'
import {
  REPO_HEADER_ACTION_BUTTON_CLASS,
  REPO_HEADER_ACTION_REVEAL_CLASS
} from './repo-header-action-button-class'
import {
  getWorktreeVisibilityMenuLabel,
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './worktree-list-project-header-events'

export function WorktreeListRepoHeaderActions({
  repo,
  label,
  createState,
  projectGroups,
  onCreateForRepo,
  onOpenRepoSettings,
  onOpenWorktreeVisibility,
  onRemoveProject,
  onCreateGroupFromRepo,
  onMoveProjectToGroup,
  onRemoveProjectFromGroup
}: {
  repo: Repo
  label: string
  createState: RepoHeaderCreateState | null
  projectGroups: readonly ProjectGroup[]
  onCreateForRepo: (projectId: string) => void
  onOpenRepoSettings: (projectId: string, sectionId?: string) => void
  onOpenWorktreeVisibility: (repo: Repo) => void
  onRemoveProject: (repo: Repo) => void
  onCreateGroupFromRepo: (repo: Repo) => void
  onMoveProjectToGroup: (repo: Repo, groupId: string) => void
  onRemoveProjectFromGroup: (repo: Repo) => void
}) {
  return (
    <>
      <DropdownMenu modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={REPO_HEADER_ACTION_BUTTON_CLASS}
                data-repo-header-action=""
                aria-label={translate(
                  'auto.components.sidebar.WorktreeList.609633a9e6',
                  'Project actions for {{value0}}',
                  { value0: label }
                )}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={stopRepoHeaderKeyboardToggle}
                onPointerDown={handleRepoHeaderActionPointerDown}
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.sidebar.WorktreeList.2ef41bf9a7', 'Project actions')}
          </TooltipContent>
        </Tooltip>
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
          <DropdownMenuItem onSelect={() => onOpenRepoSettings(repo.id)}>
            <SlidersHorizontal className="size-3.5" />
            {translate('auto.components.sidebar.WorktreeList.2cdffbc728', 'Project Settings')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => onOpenRepoSettings(repo.id, getRepositoryIconSectionId(repo.id))}
          >
            <Shapes className="size-3.5" />
            {translate('auto.components.sidebar.WorktreeList.e82d3589a1', 'Change Project Icon')}
          </DropdownMenuItem>
          {isGitRepoKind(repo) ? (
            <DropdownMenuItem onSelect={() => onOpenWorktreeVisibility(repo)}>
              <Eye className="size-3.5" />
              {getWorktreeVisibilityMenuLabel(repo)}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => onCreateGroupFromRepo(repo)}>
            <FolderPlus className="size-3.5" />
            {translate('auto.components.sidebar.WorktreeList.cbfd565f83', 'New group from project')}
          </DropdownMenuItem>
          {projectGroups.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput className="size-3.5" />
                {translate('auto.components.sidebar.WorktreeList.4a08fb55f2', 'Move to group')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {projectGroups.map((group) => (
                  <DropdownMenuItem
                    key={group.id}
                    disabled={repo.projectGroupId === group.id}
                    onSelect={() => onMoveProjectToGroup(repo, group.id)}
                  >
                    <span className="max-w-48 truncate">{group.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {repo.projectGroupId ? (
            <DropdownMenuItem onSelect={() => onRemoveProjectFromGroup(repo)}>
              <CircleX className="size-3.5" />
              {translate('auto.components.sidebar.WorktreeList.64e55f7f01', 'Remove from group')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onRemoveProject(repo)}>
            <Trash2 className="size-3.5" />
            {translate('auto.components.sidebar.WorktreeList.c83968f87f', 'Remove Project')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger asChild>
          {createState?.disabled ? (
            <span
              className={cn(
                'inline-flex cursor-not-allowed transition-[margin,max-width,opacity]',
                REPO_HEADER_ACTION_REVEAL_CLASS
              )}
              data-repo-header-action=""
              tabIndex={0}
              aria-label={createState.ariaLabel}
              onKeyDown={stopRepoHeaderKeyboardToggle}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={handleRepoHeaderActionPointerDown}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="pointer-events-none size-5 shrink-0 rounded-md text-muted-foreground transition-opacity opacity-60"
                aria-label={createState.ariaLabel}
                disabled
              >
                <Plus className="size-3" />
              </Button>
            </span>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={REPO_HEADER_ACTION_BUTTON_CLASS}
              data-repo-header-action=""
              aria-label={
                createState?.ariaLabel ??
                translate(
                  'auto.components.sidebar.WorktreeList.bb85cd86ba',
                  'Create workspace for {{value0}}',
                  { value0: label }
                )
              }
              onKeyDown={stopRepoHeaderKeyboardToggle}
              onPointerDown={handleRepoHeaderActionPointerDown}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onCreateForRepo(repo.id)
              }}
            >
              <Plus className="size-3" />
            </Button>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {createState?.tooltip ??
            translate(
              'auto.components.sidebar.WorktreeList.bb85cd86ba',
              'Create workspace for {{value0}}',
              { value0: label }
            )}
        </TooltipContent>
      </Tooltip>
    </>
  )
}
