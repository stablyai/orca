import type { WorktreeLineageSource } from '../../../../shared/sidebar-list/worktree-lineage-range'
import React from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { HostScopedWorktreeKey } from '../../../../shared/worktree/host-qualified-identity'
import {
  collectLineageChildTargetsOfKind,
  useLineageChildCounts,
  type LineageChildCounts
} from './worktree-card-slot-rollup'
import { SlotJumpTrigger, SlotKindGlyph } from './worktree-card-slot-jump'

const EMPTY_CHILDREN: readonly HostScopedWorktreeKey[] = []

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

/** "6 children", then, while collapsed, only the children that need attention, so a quiet subtree stays short. */
export function WorktreeCardChildrenChip({
  childIdentities = EMPTY_CHILDREN,
  lineageSource,
  collapsed,
  label,
  ariaLabel,
  onToggle
}: {
  childIdentities?: readonly HostScopedWorktreeKey[]
  lineageSource?: WorktreeLineageSource
  collapsed: boolean
  label: string
  ariaLabel: string
  onToggle?: React.MouseEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  // Expanded children show their own status, so the chip only speaks for them while collapsed.
  const counts = useLineageChildCounts(collapsed ? childIdentities : EMPTY_CHILDREN, lineageSource)
  const shown = ORDER.filter((kind) => counts[kind] > 0)
  return (
    <span className="inline-flex h-4 max-w-full min-w-0 items-center rounded border border-border bg-background text-[10px] leading-none text-muted-foreground shadow-xs dark:border-input dark:bg-input/30">
      <Button
        type="button"
        variant="ghost"
        size="chip"
        className="h-full min-w-0 gap-1 rounded-[3px] px-1 text-muted-foreground has-[>svg]:px-1"
        aria-label={ariaLabel}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <ChevronDown
          className={cn('size-2.5 shrink-0 transition-transform', collapsed && '-rotate-90')}
          aria-hidden
        />
        <span className="truncate">{label}</span>
      </Button>
      {shown.length > 0 ? (
        <span className="inline-flex h-full shrink-0 items-center border-l border-border">
          {shown.map((kind) => (
            <SlotJumpTrigger
              key={kind}
              label={countLabel(kind, counts[kind])}
              resolveTargets={() =>
                collectLineageChildTargetsOfKind(
                  useAppStore.getState(),
                  childIdentities,
                  kind,
                  lineageSource
                )
              }
              className="inline-flex h-full items-center gap-0.5 rounded-[3px] px-1 tabular-nums"
            >
              <SlotKindGlyph kind={kind} />
              {counts[kind]}
            </SlotJumpTrigger>
          ))}
        </span>
      ) : null}
    </span>
  )
}
