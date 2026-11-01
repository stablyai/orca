import { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useListMultiSelection } from '@/hooks/use-list-multi-selection'
import { getIntlLocale, translate } from '@/i18n/i18n'
import {
  buildResourcePtyRows,
  groupResourcePtyRows,
  type ResourcePtyRow
} from './resource-pty-view-model'
import { ResourcePtyList } from './ResourcePtyList'
import type { useResourceSessionInventory } from './use-resource-session-inventory'
import { canEndResourcePty, type useResourcePtyActions } from './use-resource-pty-actions'

const EMPTY_PTY_ROWS: ReturnType<typeof buildResourcePtyRows> = []
const ptyRowKey = (row: ResourcePtyRow): string => row.identity

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
  const panelRef = useRef<HTMLDivElement>(null)
  const getScope = useCallback(() => panelRef.current, [])
  const { sessions } = inventory.sessionInventory
  const { end: endPty } = actions
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
        : EMPTY_PTY_ROWS,
    [active, sessions, bindings, worktrees, repos, projectGroups, runtimePaneTitlesByTabId]
  )
  const groups = useMemo(() => groupResourcePtyRows(rows), [rows])
  const selectableRows = useMemo(
    () =>
      inventory.sessionsError
        ? EMPTY_PTY_ROWS
        : rows.filter((row) => canEndResourcePty(row) && !actions.ending.has(row.identity)),
    [rows, inventory.sessionsError, actions.ending]
  )
  const selection = useListMultiSelection({ items: selectableRows, getKey: ptyRowKey, getScope })
  const allSelected =
    selectableRows.length > 0 && selection.selectedKeys.size === selectableRows.length
  const unbound = useMemo(
    () => rows.reduce((count, row) => count + Number(row.binding === 'unbound'), 0),
    [rows]
  )
  const focusBodyBeforeEnd = useCallback(
    (source: Element | null) => {
      if (
        !active ||
        !scrollElement?.isConnected ||
        !source?.contains(scrollElement.ownerDocument.activeElement) ||
        !panelRef.current?.contains(source) ||
        scrollElement.getClientRects().length === 0 ||
        getComputedStyle(scrollElement).visibility !== 'visible' ||
        scrollElement.closest('[aria-hidden="true"], [inert]')
      ) {
        return
      }
      scrollElement.focus({ preventScroll: true })
    },
    [active, scrollElement]
  )
  const end = useCallback(
    (row: ResourcePtyRow) => {
      const focusedRow =
        panelRef.current?.ownerDocument.activeElement?.closest('[data-resource-pty-row]')
      focusBodyBeforeEnd(
        focusedRow?.getAttribute('data-resource-pty-row') === row.identity ? focusedRow : null
      )
      endPty(row)
    },
    [endPty, focusBodyBeforeEnd]
  )
  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border px-3 py-2">
        <div className="text-xs text-muted-foreground">
          {inventory.observedAt === null
            ? translate('resourceManager.pty.thisComputer', 'This computer')
            : translate(
                'resourceManager.pty.localOwnedCount',
                '{{count}} Orca PTYs on this computer',
                {
                  count: sessions.length,
                  defaultValue_one: '{{count}} Orca PTY on this computer'
                }
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
              time: new Date(inventory.observedAt).toLocaleTimeString(getIntlLocale())
            })}
          </div>
        )}
        {rows.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                aria-label={translate('resourceManager.pty.selectAll', 'Select all terminals')}
                checked={
                  allSelected ? true : selection.selectedKeys.size > 0 ? 'indeterminate' : false
                }
                disabled={selectableRows.length === 0}
                onCheckedChange={() => selection.setAllSelected(!allSelected)}
              />
              {translate('resourceManager.pty.selectAllShort', 'Select all')}
            </label>
            <Button
              variant="destructive"
              size="xs"
              disabled={selection.selectedItems.length === 0}
              onClick={(event) => {
                const focusedRow =
                  event.currentTarget.ownerDocument.activeElement?.closest(
                    '[data-resource-pty-row]'
                  )
                focusBodyBeforeEnd(
                  selection.selectedKeys.has(
                    focusedRow?.getAttribute('data-resource-pty-row') ?? ''
                  )
                    ? (focusedRow ?? null)
                    : event.currentTarget
                )
                void actions.endMany(selection.selectedItems)
              }}
            >
              {translate('resourceManager.pty.endSelected', 'End selected ({{count}})', {
                count: selection.selectedItems.length
              })}
            </Button>
          </div>
        )}
      </div>
      {inventory.sessionsError && (
        <div role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">
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
          selected={selection.selectedKeys}
          onSelect={selection.toggleSelection}
          onEnd={end}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  )
}
