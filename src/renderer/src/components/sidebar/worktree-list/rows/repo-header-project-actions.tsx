import { useTranslation } from 'react-i18next'
import React, { useState } from 'react'
import { useRepoSshGate } from '@/lib/workspace/catalog/use-repo-ssh-gate'
import { Ellipsis, Plus } from 'lucide-react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type {
  Repo,
  WorktreeVisibilityDefaults
} from '../../../../../../shared/repository/repo-types'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from './repo-header-action-button-class'
import { getRepoHeaderCreateState } from './repo-header-create-state'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

const LazyRepoHeaderProjectActionsMenuContent = lazyWithRetry(
  () =>
    import('./RepoHeaderProjectActionsMenuContent').then((module) => ({
      default: module.RepoHeaderProjectActionsMenuContent
    })),
  { reloadKey: 'repo-header-project-actions-menu-content' }
)

export type RepoHeaderProjectActions = {
  getWorktreeVisibilityDefaults: (repo: Repo) => WorktreeVisibilityDefaults | undefined
  onOpenRepoSettings: (projectId: string, sectionId?: string) => void
  onOpenWorktreeVisibility: (repo: Repo) => void
  onCreateGroupFromRepo: (repo: Repo) => void
  onMoveProjectToGroup: (repo: Repo, groupId: string) => void
  onRemoveProjectFromGroup: (repo: Repo) => void
  onRemoveProject: (repo: Repo) => void
  /** `pinHost`: the header's rows all sit on its repo's host, so that registration names the host. */
  onCreateForRepo: (repo: Repo, options: { pinHost: boolean }) => void
}

// Memoized: the sidebar re-renders every header row when the active workspace changes.
export const RepoHeaderProjectActionsMenu = React.memo(function RepoHeaderProjectActionsMenu({
  repo,
  hostRepos,
  label,
  projectGroups,
  actions
}: {
  repo: Repo
  /** A header spanning hosts: every copy it shows, which Hide hides together. */
  hostRepos?: ReadonlyMap<string, Repo>
  label: string
  projectGroups: readonly ProjectGroup[]
  actions: RepoHeaderProjectActions
}): React.JSX.Element {
  const t = useTranslate()
  // Memoized: subscribe so a language change still repaints its labels.
  useTranslation()
  const [open, setOpen] = useState(false)
  const hasOpened = useLatchedOpen(open)
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
              aria-label={t(
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
          {t('auto.components.sidebar.WorktreeList.2ef41bf9a7', 'Project actions')}
        </TooltipContent>
      </Tooltip>
      {hasOpened ? (
        <React.Suspense fallback={null}>
          <LazyRepoHeaderProjectActionsMenuContent
            repo={repo}
            hostRepos={hostRepos}
            label={label}
            projectGroups={projectGroups}
            actions={actions}
          />
        </React.Suspense>
      ) : null}
    </DropdownMenu>
  )
})

export const RepoHeaderCreateWorkspaceButton = React.memo(function RepoHeaderCreateWorkspaceButton({
  repo,
  label,
  pinHost = false,
  onCreateForRepo
}: {
  repo: Repo
  label: string
  pinHost?: boolean
  onCreateForRepo: RepoHeaderProjectActions['onCreateForRepo']
}): React.JSX.Element {
  const t = useTranslate()
  // Memoized: subscribe so a language change still repaints its labels.
  useTranslation()
  const sshGate = useRepoSshGate(repo)
  const createState = getRepoHeaderCreateState({ repo, label, sshGate }, t)
  const fallbackLabel = t(
    'auto.components.sidebar.WorktreeList.bb85cd86ba',
    'Create workspace for {{value0}}',
    { value0: label }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {createState?.disabled ? (
          <span
            className="inline-flex size-5 shrink-0 cursor-not-allowed"
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
              onCreateForRepo(repo, { pinHost })
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
