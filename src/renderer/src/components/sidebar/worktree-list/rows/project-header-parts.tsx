import React, { useCallback } from 'react'
import { ChevronRight, GitBranch, MessageSquare, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'
import { startProjectChat } from './start-chat'
import { cn } from '@/lib/class-names'
import { useNow } from '@/lib/window-activity/use-now'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import StatusIndicator from '../../workspace-card/surface/StatusIndicator'
import { selectWorktreeActivityStatus } from '../../workspace-card/activity/use-worktree-activity-status'
import { useAgentPresentation } from '../../workspace-card/activity/useWorktreeAgentRows'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WorktreeStatus } from '../../../../../../shared/worktree/row-display/worktree-status-rollup'
import { isProjectHome, mainCheckoutOf } from '../listing/project-chat-rows'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'

// The sidebar dot's priority order; a collapsed project shows its most urgent workspace.
const STATUS_PRIORITY: readonly WorktreeStatus[] = [
  'permission',
  'failed',
  'working',
  'monitoring',
  'unconfirmed',
  'interrupted'
]

export function HeaderChevron({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  return (
    <ChevronRight
      aria-hidden
      className={cn(
        'size-3 shrink-0 text-muted-foreground transition-transform',
        !collapsed && 'rotate-90'
      )}
    />
  )
}

/** A collapsed project's one-line summary: most urgent status, chat and worktree counts, last activity. */
export const ProjectSummary = React.memo(function ProjectSummary({
  repo,
  hostId
}: {
  repo: Repo
  /** The header's host section; a project on several hosts summarizes each copy apart. */
  hostId: ExecutionHostId | undefined
}): React.JSX.Element {
  const allCopies = useAppStore((s) => selectWorktreesByRepo(s)[repo.id]) ?? []
  const worktrees = hostId
    ? allCopies.filter((worktree) => (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId)
    : allCopies
  const mainId = worktrees.find(isProjectHome)?.id
  const ids = worktrees.map((worktree) => worktree.id).join('\n')
  const status = useAppStore((s) => {
    const present = new Set(ids.split('\n').map((id) => selectWorktreeActivityStatus(s, id)))
    return STATUS_PRIORITY.find((candidate) => present.has(candidate)) ?? null
  })
  const chats = useAgentPresentation(
    `roots\0${mainId ?? ''}`,
    useCallback((p) => (mainId ? p.display.roots(mainId).length : 0), [mainId])
  )
  const now = useNow(60_000)
  const worktreeCount = worktrees.filter((worktree) => worktree.id !== mainId).length
  const lastActivityAt = Math.max(0, ...worktrees.map((worktree) => worktree.lastActivityAt))
  return (
    // Hidden under the hover actions, which would otherwise cover it only in part.
    <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11px] font-normal text-muted-foreground group-hover:invisible">
      {status ? <StatusIndicator status={status} /> : null}
      {chats > 0 ? (
        <span className="flex items-center gap-0.5">
          <MessageSquare className="size-3" aria-hidden />
          {chats}
        </span>
      ) : null}
      {worktreeCount > 0 ? (
        <span className="flex items-center gap-0.5">
          <GitBranch className="size-3" aria-hidden />
          {worktreeCount}
        </span>
      ) : null}
      {lastActivityAt > 0 ? <span>{formatShortTimeAgo(lastActivityAt, now)}</span> : null}
    </span>
  )
})

/** The header's "new chat" action, so a collapsed or long project can start one without scrolling to its "+ chat". */
export const ProjectChatHeaderButton = React.memo(function ProjectChatHeaderButton({
  repo,
  label,
  hostId
}: {
  repo: Repo
  label: string
  hostId: ExecutionHostId | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const main = useAppStore((s) => mainCheckoutOf(repo, selectWorktreesByRepo(s), hostId))
  if (!main) {
    return null
  }
  const title = t('components.sidebar.projectChats.newChatIn', 'New chat in {{name}}', {
    name: label
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          // Muted until hovered, at the 20px of the header's other actions.
          variant="muted-field-icon"
          size="icon-xs"
          className="size-5 shrink-0"
          data-repo-header-action=""
          aria-label={title}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            startProjectChat(main)
          }}
        >
          <MessageSquarePlus className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {title}
      </TooltipContent>
    </Tooltip>
  )
})
