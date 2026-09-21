import React from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type {
  BoundClaudeHomeStatus,
  BoundClaudeHomeUsage
} from '../../../../shared/rate-limit-types'
import { InlineUsageBars, InlineUsageSkeleton } from './InlineProviderUsage'

type BoundClaudeHomeGroup = { id: string; name: string }

function unavailableStatusLabel(status: Exclude<BoundClaudeHomeStatus, 'ok'>): string {
  if (status === 'signed-out') {
    return translate('auto.components.status.bar.BoundClaudeHomesSection.cd0caf7de4', 'Signed out')
  }
  if (status === 'expired') {
    return translate(
      'auto.components.status.bar.BoundClaudeHomesSection.38a934f31f',
      'Session expired'
    )
  }
  if (status === 'unavailable') {
    // Why a separate line: the directory is fine, Orca's usage call is not — "Directory unreadable"
    // would send the user to check permissions on a directory that has nothing wrong with it.
    return translate(
      'auto.components.status.bar.BoundClaudeHomesSection.7b3c1d94ae',
      'Usage unavailable'
    )
  }
  return translate(
    'auto.components.status.bar.BoundClaudeHomesSection.cfcef0699a',
    'Directory unreadable'
  )
}

function BoundClaudeHomeUsageLine({ row }: { row: BoundClaudeHomeUsage }): React.JSX.Element {
  if (row.isFetching && !row.rateLimits) {
    return <InlineUsageSkeleton />
  }
  if (row.status !== 'ok') {
    // Why: Orca only reads a bound directory, so an expired token is a state to report, never a
    // refresh to attempt — the user fixes it in their own Claude CLI.
    return (
      <span className="text-[10px] text-muted-foreground">
        {unavailableStatusLabel(row.status)}
      </span>
    )
  }
  return row.rateLimits ? (
    <InlineUsageBars limits={row.rateLimits} isFetching={row.isFetching} />
  ) : (
    <InlineUsageSkeleton />
  )
}

/**
 * Usage for each project group bound to its own CLAUDE_CONFIG_DIR. `rows` is optional because a
 * remote host that predates bound-home usage sends no array at all; that renders nothing.
 */
export function BoundClaudeHomesSection({
  rows,
  groups
}: {
  rows: BoundClaudeHomeUsage[] | undefined
  groups: readonly BoundClaudeHomeGroup[]
}): React.JSX.Element | null {
  if (!rows || rows.length === 0) {
    return null
  }
  return (
    <div className="px-1 pb-1">
      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {translate('auto.components.status.bar.BoundClaudeHomesSection.36b1b954e0', 'Bound groups')}
      </div>
      <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
        {rows.map((row) => (
          <DropdownMenuItem key={row.groupId} disabled>
            <div className="flex w-full flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {groups.find((group) => group.id === row.groupId)?.name ?? row.configDir}
                </span>
              </div>
              <BoundClaudeHomeUsageLine row={row} />
            </div>
          </DropdownMenuItem>
        ))}
      </div>
    </div>
  )
}
