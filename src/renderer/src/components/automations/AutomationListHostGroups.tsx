import React from 'react'
import { Button } from '@/components/ui/button'
import { AutomationHostLabel, AutomationHostStatusBadges } from './AutomationHostBadges'
import {
  AutomationListLocalRows,
  type AutomationListLocalRowsProps
} from './AutomationListLocalRows'
import type { AutomationHostVisibleGroup } from './automation-host-list-rows'
import {
  resolveAutomationHostGroupEmptyState,
  type AutomationListEmptyState
} from './automation-list-empty-state'
import {
  automationHostRecoveryActions,
  recoveryActionLabel,
  type AutomationHostRecoveryAction
} from './automation-host-status-descriptors'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'

/**
 * The All-hosts list: rows grouped by authority, each host anchoring its own
 * status row.
 *
 * The status sits on the host header rather than on the rows because it is a
 * fact about the host, and because a host with no rows still has to say why —
 * an unreachable host that rendered as an empty gap would read as "nothing
 * scheduled here", which is the one thing we have not established.
 */

export type AutomationListHostGroupsProps = Omit<AutomationListLocalRowsProps, 'rows'> & {
  groups: readonly AutomationHostVisibleGroup[]
  searchActive: boolean
  onRecover: (action: AutomationHostRecoveryAction, entry: AutomationHostCatalogEntry) => void
}

function hostRecoveryAction(
  entry: AutomationHostCatalogEntry
): AutomationHostRecoveryAction | null {
  const recovery = automationHostRecoveryActions(entry)
  return recovery.authority ?? recovery.execution
}

function AutomationHostGroupState({
  state,
  recovery,
  onRecover
}: {
  state: AutomationListEmptyState
  recovery: AutomationHostRecoveryAction | null
  onRecover: (action: AutomationHostRecoveryAction) => void
}): React.JSX.Element {
  return (
    <div className="px-3 pb-1 text-xs text-muted-foreground" data-empty-state={state.kind}>
      <div>{state.title}</div>
      {state.detail ? <div>{state.detail}</div> : null}
      {recovery ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-1"
          onClick={() => onRecover(recovery)}
        >
          {recoveryActionLabel(recovery)}
        </Button>
      ) : null}
    </div>
  )
}

export function AutomationListHostGroups({
  groups,
  searchActive,
  onRecover,
  ...rowProps
}: AutomationListHostGroupsProps): React.JSX.Element {
  return (
    <>
      {groups.map((group) => (
        <section key={group.authorityKey} className="mb-2" data-authority-key={group.authorityKey}>
          <div className="px-2 pb-1 text-[11px] font-medium uppercase text-muted-foreground">
            {group.authorityLabel}
          </div>
          {group.hosts.map(({ entry, rows, hostRowCount }) => {
            const action = hostRecoveryAction(entry)
            const state = resolveAutomationHostGroupEmptyState({
              entry,
              hostRowCount,
              visibleRowCount: rows.length,
              searchActive
            })
            return (
              <div key={entry.stableKey} className="mb-1" data-host-group={entry.stableKey}>
                <div className="flex flex-wrap items-center gap-1.5 px-2 py-1">
                  <AutomationHostLabel entry={entry} className="min-w-0 flex-1" />
                  <AutomationHostStatusBadges entry={entry} />
                  {action ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => onRecover(action, entry)}
                    >
                      {recoveryActionLabel(action)}
                    </Button>
                  ) : null}
                </div>
                {state.kind === 'rows' ? (
                  <AutomationListLocalRows {...rowProps} rows={rows} />
                ) : (
                  <AutomationHostGroupState
                    state={state}
                    // The header already offers this host's action; repeating it says nothing new.
                    recovery={state.recovery === action ? null : state.recovery}
                    onRecover={(recovery) => onRecover(recovery, entry)}
                  />
                )}
              </div>
            )
          })}
        </section>
      ))}
    </>
  )
}
