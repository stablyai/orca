import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { buildResourcePtyRows, groupResourcePtyRows } from './resource-pty-view-model'
import { ResourcePtyList } from './ResourcePtyList'
import type { useResourceSessionInventory } from './use-resource-session-inventory'
import type { useResourcePtyActions } from './use-resource-pty-actions'

type Props = Omit<Parameters<typeof buildResourcePtyRows>[0], 'sessions'> & {
  active: boolean
  inventory: ReturnType<typeof useResourceSessionInventory>
  actions: ReturnType<typeof useResourcePtyActions>
  onNavigate: (tabId: string, paneKey: string | null) => void
}

export function ResourcePtyPanel({
  active,
  inventory,
  actions,
  onNavigate,
  bindings,
  worktrees,
  repos,
  projectGroups,
  runtimePaneTitlesByTabId
}: Props) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const { sessions } = inventory.sessionInventory
  const rows = useMemo(
    () =>
      active
        ? buildResourcePtyRows({
            bindings,
            worktrees,
            repos,
            projectGroups,
            runtimePaneTitlesByTabId,
            sessions
          })
        : [],
    [active, sessions, bindings, worktrees, repos, projectGroups, runtimePaneTitlesByTabId]
  )
  const groups = useMemo(() => groupResourcePtyRows(rows), [rows])
  const unbound = rows.filter((row) => row.binding === 'unbound').length
  return (
    <div className="flex h-[420px] flex-col">
      <div className="space-y-2 border-b border-border px-3 py-2">
        <div className="text-xs text-muted-foreground">
          {inventory.observedAt === null
            ? translate('resourceManager.pty.thisComputer', 'This computer')
            : translate(
                sessions.length === 1
                  ? 'resourceManager.pty.localOwnedCount_one'
                  : 'resourceManager.pty.localOwnedCount_other',
                sessions.length === 1
                  ? '{{count}} Orca PTY on this computer'
                  : '{{count}} Orca PTYs on this computer',
                { count: sessions.length }
              )}
          {inventory.observedAt !== null && unbound > 0 && (
            <span>
              {' · '}
              {translate('resourceManager.pty.withoutTab', '{{count}} without a tab', {
                count: unbound
              })}
            </span>
          )}
        </div>
        {inventory.observedAt !== null && (
          <div className="text-xs text-muted-foreground">
            {translate('resourceManager.pty.observedTime', 'Last observed {{time}}', {
              time: new Date(inventory.observedAt).toLocaleTimeString()
            })}
          </div>
        )}
      </div>
      {inventory.sessionsError && (
        <div role="alert" className="px-3 py-2 text-xs text-destructive">
          {translate(
            'resourceManager.pty.failed',
            'Unverifiable: local terminals could not be refreshed. Last-observed terminals are shown.'
          )}{' '}
          <Button variant="link" size="xs" onClick={() => void inventory.refreshSessions()}>
            {translate('resourceManager.pty.retry', 'Retry')}
          </Button>
        </div>
      )}
      <div
        ref={setScrollElement}
        data-resource-pty-body
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {inventory.observedAt === null && !inventory.sessionsError && (
          <p role="status" className="p-3 text-xs text-muted-foreground">
            {translate('resourceManager.pty.loading', 'Loading terminals…')}
          </p>
        )}
        {inventory.observedAt !== null && sessions.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">
            {translate('resourceManager.pty.noLocalOrcaPtys', 'No local Orca PTYs')}
          </p>
        )}
        <ResourcePtyList
          groups={groups}
          scrollElement={scrollElement}
          observedAt={inventory.observedAt}
          unverifiable={inventory.sessionsError}
          ending={actions.ending}
          errors={actions.errors}
          onEnd={actions.confirm}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  )
}
