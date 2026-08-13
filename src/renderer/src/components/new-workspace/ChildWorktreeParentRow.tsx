import React from 'react'
import { Check, GitBranch, GitFork } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { Worktree } from '../../../../shared/types'

export function childWorktreeParentBranchLabel(worktree: Worktree): string {
  return worktree.branch.replace(/^refs\/heads\//, '') || 'Detached HEAD'
}

export function ChildWorktreeParentRow({
  worktree,
  armed,
  selected,
  current,
  optionId,
  onArm,
  onCommit
}: {
  worktree: Worktree
  armed: boolean
  selected: boolean
  current: boolean
  optionId: string | undefined
  onArm: () => void
  onCommit: () => void
}): React.JSX.Element {
  return (
    <div
      role="option"
      id={optionId}
      aria-selected={selected}
      data-armed={armed || undefined}
      data-current={current ? 'true' : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onArm}
      onClick={onCommit}
      className={cn(
        'flex min-h-12 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
        armed &&
          'bg-[color-mix(in_srgb,var(--foreground)_12%,var(--popover))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_18%,transparent)]',
        selected && !armed && 'bg-accent/60'
      )}
    >
      <GitFork className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn('truncate text-[13px]', selected && 'font-medium')}>
            {worktree.displayName}
          </span>
          {current ? (
            <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-px text-[9px] font-medium leading-none text-muted-foreground">
              {translate(
                'auto.components.new.workspace.ChildWorktreeParentField.current',
                'Current'
              )}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
          <GitBranch className="size-3 shrink-0" aria-hidden="true" />
          <span className="max-w-[45%] shrink-0 truncate">
            {childWorktreeParentBranchLabel(worktree)}
          </span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate font-mono" title={worktree.path}>
            {worktree.path}
          </span>
        </div>
      </div>
      <Check
        className={cn('size-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
        aria-hidden="true"
      />
    </div>
  )
}
