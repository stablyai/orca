import type { WorktreeVisibilityDefaults } from '../../../../../../shared/global-settings-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'

import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import {
  type ExecutionHostId,
  getRepoExecutionHostId
} from '../../../../../../shared/execution-host'
import { useTranslation } from 'react-i18next'
import React, { useMemo, useState } from 'react'
import { useProjectGroupOperation } from '../../use-project-group-operation'
import {
  type ProjectGroupOperation,
  currentProjectGroupMember,
  resolveProjectGroupOperation
} from '../../project-group-operation'
import { useAppStore } from '@/store'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import { useRepoSshGate } from '@/hooks/use-repo-ssh-gate'
import {
  CircleX,
  Ellipsis,
  Eye,
  FolderInput,
  FolderTree,
  Plus,
  // `Shapes` is lucide-react's own export name; exempted in config/oxlint-anti-slop.json.
  Shapes,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getRepositoryIconSectionId } from '@/components/settings/repository/repository-settings-targets'
import { WslMoveProjectMenuItem } from '@/components/wsl-move/WslMoveProjectMenuItem'

import { isGitRepoKind } from '../../../../../../shared/repo-kind'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../../../shared/worktree/ownership'
import {
  REPO_HEADER_ACTION_BUTTON_CLASS,
  REPO_HEADER_ACTION_REVEAL_CLASS
} from '../../repo-header-action-button-class'
import { getRepoHeaderCreateState } from '../../repo-header-create-state'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './header-event-guards'

function getWorktreeVisibilityMenuLabel(
  repo: Repo,
  visibilityDefaults?: WorktreeVisibilityDefaults
): string {
  const visibility = effectiveExternalWorktreeVisibility(
    repo,
    isLegacyRepoForExternalWorktreeVisibility(repo),
    visibilityDefaults
  )
  return visibility === 'show'
    ? translate(
        'auto.components.sidebar.repoHeaderProjectActions.hideNonOrcaWorktrees',
        'Hide non-Orca worktrees'
      )
    : translate(
        'auto.components.sidebar.repoHeaderProjectActions.showHiddenWorktrees',
        'Show hidden worktrees'
      )
}

export type RepoHeaderProjectActions = {
  getWorktreeVisibilityDefaults: (repo: Repo) => WorktreeVisibilityDefaults | undefined
  onOpenRepoSettings: (projectId: string, sectionId?: string, hostId?: ExecutionHostId) => void
  onOpenWorktreeVisibility: (
    repo: Repo,
    scope?: GroupHeaderRow['projectScope'],
    hostId?: ExecutionHostId
  ) => void
  onCreateGroupFromRepo: (operation: ProjectGroupOperation) => void
  onMoveProjectToGroup: (operation: ProjectGroupOperation, groupId: string) => void
  onRemoveProjectFromGroup: (operation: ProjectGroupOperation) => void
  onRemoveProject: (repo: Repo, scope?: GroupHeaderRow['projectScope']) => void
  /** `pinHost`: the header heads one host section, so its repo is that host's own registration. */
  onCreateForRepo: (
    repo: Repo,
    options: { pinHost: boolean; projectScope?: GroupHeaderRow['projectScope'] }
  ) => void
}

/** Navigation carries H, never a host/raw convenience-map winner or an armed removal. */
export function openProjectRemovalSettings(
  repo: Repo,
  scope?: GroupHeaderRow['projectScope']
): void {
  const state = useAppStore.getState()
  if (!currentProjectGroupMember(state, repo)) {
    return
  }
  const key = scope?.key ?? resolveProjectGroupOperation(state, { kind: 'repo', repo })?.groupKey
  if (!key || !getProjectGroupingIndexFromState(state).groupByKey.has(key)) {
    return
  }
  state.openSettingsTarget({
    pane: 'repo',
    repoId: repo.id,
    hostId: getRepoExecutionHostId(repo),
    sectionId: `repo-${key}`
  })
  state.openSettingsPage()
}

// Memoized: the sidebar re-renders every header row when the active workspace changes.
export const RepoHeaderProjectActionsMenu = React.memo(function RepoHeaderProjectActionsMenu({
  repo,
  contextRepo = repo,
  projectScope,
  hostId,
  label,
  actions
}: {
  repo?: Repo
  contextRepo?: Repo
  projectScope?: GroupHeaderRow['projectScope']
  hostId?: ExecutionHostId
  label: string
  projectGroups: readonly ProjectGroup[]
  actions: RepoHeaderProjectActions
}): React.JSX.Element | null {
  // Memoized: subscribe so a language change still repaints its labels.
  useTranslation()
  const [open, setOpen] = useState(false)
  const catalogHostId =
    hostId ?? projectScope?.catalogHostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
  const entrance = useMemo(
    () =>
      projectScope && catalogHostId
        ? { kind: 'header' as const, groupKey: projectScope.key, catalogHostId }
        : repo
          ? { kind: 'repo' as const, repo }
          : null,
    [projectScope?.key, catalogHostId, repo]
  )
  const operation = useProjectGroupOperation(open, entrance)
  if (!contextRepo) {
    return null
  }
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
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
        <DropdownMenuItem
          onSelect={() =>
            actions.onOpenRepoSettings(
              contextRepo.id,
              undefined,
              getRepoExecutionHostId(contextRepo)
            )
          }
        >
          <SlidersHorizontal className="size-3.5" />
          {translate('auto.components.sidebar.WorktreeList.2cdffbc728', 'Project Settings')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            actions.onOpenRepoSettings(
              contextRepo.id,
              getRepositoryIconSectionId(contextRepo.id),
              getRepoExecutionHostId(contextRepo)
            )
          }
        >
          <Shapes className="size-3.5" />
          {translate('auto.components.sidebar.WorktreeList.e82d3589a1', 'Change Project Icon')}
        </DropdownMenuItem>
        {isGitRepoKind(contextRepo) ||
        projectScope?.registrations.some((setup) => setup.kind !== 'folder') ? (
          <DropdownMenuItem
            onSelect={() => actions.onOpenWorktreeVisibility(contextRepo, projectScope, hostId)}
          >
            <Eye className="size-3.5" />
            {projectScope && projectScope.registrations.length > 1
              ? translate(
                  'auto.components.sidebar.WorktreeVisibilityDialog.83a5ba8dd1',
                  'Non-Orca worktrees'
                )
              : getWorktreeVisibilityMenuLabel(
                  contextRepo,
                  actions.getWorktreeVisibilityDefaults(contextRepo)
                )}
          </DropdownMenuItem>
        ) : null}
        {operation ? (
          <>
            <DropdownMenuItem onSelect={() => actions.onCreateGroupFromRepo(operation)}>
              {/* Not FolderPlus: that now means "Add project" in the sidebar header above. */}
              <FolderTree className="size-3.5" />
              {translate(
                'auto.components.sidebar.WorktreeList.cbfd565f83',
                'New group from project'
              )}
            </DropdownMenuItem>
            {operation.destinations.length > 0 ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderInput className="size-3.5" />
                  {translate('auto.components.sidebar.WorktreeList.4a08fb55f2', 'Move to group')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {operation.destinations.map((group) => (
                    <DropdownMenuItem
                      key={group.id}
                      disabled={operation.uniformGroupId === group.id}
                      onSelect={() => actions.onMoveProjectToGroup(operation, group.id)}
                    >
                      <span className="max-w-48 truncate">{group.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {operation.grouped ? (
              <DropdownMenuItem onSelect={() => actions.onRemoveProjectFromGroup(operation)}>
                <CircleX className="size-3.5" />
                {translate('auto.components.sidebar.WorktreeList.64e55f7f01', 'Remove from group')}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        {repo ? <WslMoveProjectMenuItem repo={repo} /> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => actions.onRemoveProject(contextRepo, projectScope)}
        >
          <Trash2 className="size-3.5" />
          {translate('auto.components.sidebar.WorktreeList.c83968f87f', 'Remove Project')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

export const RepoHeaderCreateWorkspaceButton = React.memo(function RepoHeaderCreateWorkspaceButton({
  repo,
  label,
  pinHost = false,
  projectScope,
  onCreateForRepo
}: {
  repo: Repo
  label: string
  pinHost?: boolean
  projectScope?: GroupHeaderRow['projectScope']
  onCreateForRepo: RepoHeaderProjectActions['onCreateForRepo']
}): React.JSX.Element {
  // Memoized: subscribe so a language change still repaints its labels.
  useTranslation()
  const sshGate = useRepoSshGate(repo)
  const createState =
    projectScope && !pinHost ? undefined : getRepoHeaderCreateState({ repo, label, sshGate })
  const fallbackLabel = translate(
    'auto.components.sidebar.WorktreeList.bb85cd86ba',
    'Create workspace for {{value0}}',
    { value0: label }
  )
  return (
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
            aria-label={createState?.ariaLabel ?? fallbackLabel}
            onKeyDown={stopRepoHeaderKeyboardToggle}
            onPointerDown={handleRepoHeaderActionPointerDown}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onCreateForRepo(repo, { pinHost, ...(projectScope ? { projectScope } : {}) })
            }}
          >
            <Plus className="size-3" />
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {createState?.tooltip ?? fallbackLabel}
      </TooltipContent>
    </Tooltip>
  )
})
