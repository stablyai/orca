import React from 'react'
import { ChevronDown, CircleX } from 'lucide-react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useLineageChildCounts, type LineageChildCounts } from './worktree-card-slot-rollup'

const EMPTY_CHILD_IDS: readonly string[] = []

// Most urgent first, matching the slot's priority.
const ORDER: readonly (keyof LineageChildCounts)[] = ['needs', 'failed', 'unread', 'working']

function countLabel(kind: keyof LineageChildCounts, count: number): string {
  switch (kind) {
    case 'needs':
      return translate('sidebar.cardSlot.childNeeds', '{{count}} need you', {
        count,
        defaultValue_one: '{{count}} needs you'
      })
    case 'failed':
      return translate('sidebar.cardSlot.childFailed', '{{count}} failed', { count })
    case 'unread':
      return translate('sidebar.cardSlot.childUnread', '{{count}} unread', { count })
    case 'working':
      return translate('sidebar.cardSlot.childWorking', '{{count}} working', { count })
  }
}

// The slot's glyphs, so a count reads the same as the row it stands for.
function CountGlyph({ kind }: { kind: keyof LineageChildCounts }): React.JSX.Element {
  switch (kind) {
    case 'needs':
      return <AgentQuestionIcon className="size-2.5 shrink-0" />
    case 'failed':
      return <CircleX className="size-2.5 shrink-0 text-destructive" aria-hidden />
    case 'working':
      return <AgentWorkingSpinner className="size-2 border-[1.5px]" />
    case 'unread':
      return <span className="size-1.5 shrink-0 rounded-full bg-unread" />
  }
}

/** "6 children", then only the children that need attention, so a quiet subtree stays short. */
export function WorktreeCardChildrenChip({
  childWorktreeIds = EMPTY_CHILD_IDS,
  collapsed,
  label,
  ariaLabel,
  onToggle
}: {
  childWorktreeIds?: readonly string[]
  collapsed: boolean
  label: string
  ariaLabel: string
  onToggle?: React.MouseEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  const counts = useLineageChildCounts(childWorktreeIds)
  const shown = ORDER.filter((kind) => counts[kind] > 0)
  const description = shown.map((kind) => countLabel(kind, counts[kind])).join(', ')
  return (
    <Button
      type="button"
      variant="outline"
      size="chip"
      className="max-w-full min-w-0 gap-1 text-muted-foreground"
      aria-label={description ? `${ariaLabel}. ${description}` : ariaLabel}
      aria-expanded={!collapsed}
      title={description || undefined}
      onClick={onToggle}
    >
      <ChevronDown
        className={cn('size-2.5 shrink-0 transition-transform', collapsed && '-rotate-90')}
        aria-hidden
      />
      <span className="truncate">{label}</span>
      {shown.length > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 border-l border-border pl-1"
          aria-hidden
        >
          {shown.map((kind) => (
            <span key={kind} className="inline-flex items-center gap-0.5 tabular-nums">
              <CountGlyph kind={kind} />
              {counts[kind]}
            </span>
          ))}
        </span>
      ) : null}
    </Button>
  )
}
