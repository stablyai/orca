import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { translate } from '@/i18n/i18n'
import type { CollapsedGroupCountBadgeMode } from '../../../../../../shared/collapsed-group-count-badge'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'

export function sectionWorkspaceCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.sidebar.sectionWorkspaceCount_one', '{{count}} workspace', {
        count
      })
    : translate('auto.components.sidebar.sectionWorkspaceCount_other', '{{count}} workspaces', {
        count
      })
}

/**
 * Which of the two badges a collapsed section header shows, and with what number.
 *
 * `total` comes from the header's own workspace ids so a project group reports workspaces rather
 * than child projects, which is what its `count` carries. `attention` is the intersection with the
 * attention set in the same host-qualified key space, so a workspace hidden by a sidebar filter,
 * or the twin of a waiting workspace on another host, is never counted.
 */
export function getSectionCountBadges(
  row: Pick<GroupHeaderRow, 'count' | 'countedWorkspaceIds'>,
  mode: CollapsedGroupCountBadgeMode,
  attentionWorkspaceIds: ReadonlySet<string>
): { total: number | null; attention: number | null } {
  if (mode === 'off') {
    return { total: null, attention: null }
  }
  const countedWorkspaceIds = row.countedWorkspaceIds
  const total = countedWorkspaceIds ? countedWorkspaceIds.length : row.count
  if (total === 0) {
    return { total: null, attention: null }
  }
  // Why a set: a project group's subtree can list one workspace under more than one lane.
  const attention = new Set(
    (countedWorkspaceIds ?? []).filter((workspaceId) => attentionWorkspaceIds.has(workspaceId))
  ).size
  return {
    total: mode === 'all' ? total : null,
    attention: attention > 0 ? attention : null
  }
}

/** Neutral pill with a section's workspace total. Shared by host headers and collapsed groups. */
export function SectionWorkspaceCountBadge({ count }: { count: number }): React.JSX.Element {
  const totalLabel = sectionWorkspaceCountLabel(count)

  return (
    <span
      className="inline-flex h-4 shrink-0 overflow-hidden rounded-full border border-worktree-sidebar-border bg-worktree-sidebar-accent text-[9px] font-medium leading-none text-muted-foreground/90"
      aria-label={totalLabel}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-full min-w-4 items-center justify-center px-1.5 tabular-nums">
            {count}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {totalLabel}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

/** How many workspaces in a section have an agent waiting on the user. Same icon and token as
 *  every other "the agent is asking you something" surface. */
export function SectionAttentionCountBadge({ count }: { count: number }): React.JSX.Element {
  const label =
    count === 1
      ? translate('auto.components.sidebar.sectionAttentionCount_one', '{{count}} waiting on you', {
          count
        })
      : translate(
          'auto.components.sidebar.sectionAttentionCount_other',
          '{{count}} waiting on you',
          { count }
        )

  return (
    <span className="inline-flex h-4 shrink-0 items-center" aria-label={label}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-full items-center gap-0.5 text-[9px] font-medium leading-none tabular-nums text-agent-question">
            <AgentQuestionIcon className="size-2.5" />
            {count}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
