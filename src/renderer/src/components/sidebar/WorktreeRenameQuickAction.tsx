import React from 'react'
import { Pencil } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

// Why: the rename action is the only header action revealed by plain hover, so it
// must occupy zero width at rest — otherwise every row that previously rendered no
// header actions gains a permanent gutter. Collapsing opacity alone is not enough:
// the flex `gap-1` between siblings and the group's trailing `pr-1.5` both survive a
// zero-opacity child, so those are collapsed alongside the button's own width.
const RENAME_REVEAL_CLASS =
  'max-w-0 overflow-hidden opacity-0 group-hover/worktree-card:max-w-4 group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:max-w-4 group-focus-within/worktree-card:opacity-100 focus-visible:max-w-4 focus-visible:opacity-100'

// Why: a collapsed sibling still contributes the parent's flex gap, so cancel it
// while collapsed and restore it on reveal.
const RENAME_GAP_COLLAPSE_CLASS =
  '-ml-1 group-hover/worktree-card:ml-0 group-focus-within/worktree-card:ml-0 focus-visible:ml-0'

/**
 * Trailing gutter for the header-action group. Applied by the parent so the group
 * reserves no width until the rename action is revealed.
 */
export function worktreeHeaderActionsPaddingClass(hasAlwaysVisibleAction: boolean): string {
  return hasAlwaysVisibleAction
    ? 'pr-1.5'
    : 'pr-0 group-hover/worktree-card:pr-1.5 group-focus-within/worktree-card:pr-1.5'
}

type WorktreeRenameQuickActionProps = {
  /** True when a always-visible action (the primary star) renders before this one. */
  hasPrecedingAction: boolean
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void
  onRename: (event: React.MouseEvent<HTMLButtonElement>) => void
}

export function WorktreeRenameQuickAction({
  hasPrecedingAction,
  onPointerDown,
  onRename
}: WorktreeRenameQuickActionProps): React.JSX.Element {
  const label = translate(
    'auto.components.sidebar.WorktreeRenameQuickAction.renameWorkspace',
    'Rename workspace'
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-workspace-board-preserve-open=""
          data-worktree-rename-quick-action=""
          onPointerDown={onPointerDown}
          onClick={onRename}
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded bg-transparent',
            'transition-[max-width,opacity,margin,color,background-color]',
            RENAME_REVEAL_CLASS,
            hasPrecedingAction && RENAME_GAP_COLLAPSE_CLASS,
            'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
            'focus-visible:bg-accent/70 focus-visible:text-foreground'
          )}
          aria-label={label}
        >
          <Pencil className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
