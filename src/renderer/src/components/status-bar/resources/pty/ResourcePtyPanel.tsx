import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useListMultiSelection } from '@/lib/list-interaction/use-list-multi-selection'
import { useTranslate } from '@/i18n/use-translate'
import {
  buildResourcePtyRows,
  groupResourcePtyRows,
  type ResourcePtyGroup,
  type ResourcePtyRow
} from './resource-pty-view-model'
import { ResourcePtyList, type ResourcePtyListItem } from './ResourcePtyList'
import type { useResourceSessionInventory } from '../inventory/use-resource-session-inventory'
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
  const t = useTranslate()
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
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set())
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(new Set())
  const isEndable = useCallback(
    (row: ResourcePtyRow) =>
      !inventory.sessionsError && canEndResourcePty(row) && !actions.ending.has(row.identity),
    [inventory.sessionsError, actions.ending]
  )
  const { items, selectableRows } = useMemo(() => {
    const list: ResourcePtyListItem[] = []
    const selectable: ResourcePtyRow[] = []
    for (const group of groups) {
      const open = openGroups.has(group.key)
      list.push({
        kind: 'group',
        key: group.key,
        group,
        open,
        canEndAll: group.rows.some(isEndable)
      })
      if (!open) {
        continue
      }
      for (const row of group.rows) {
        list.push({
          kind: 'session',
          key: row.identity,
          row,
          showWorkspace: group.kind === 'unbound'
        })
        if (isEndable(row)) {
          selectable.push(row)
        }
      }
    }
    return { items: list, selectableRows: selectable }
  }, [groups, openGroups, isEndable])
  const selection = useListMultiSelection({ items: selectableRows, getKey: ptyRowKey, getScope })
  const { updateSelectionForGesture, setAllSelected } = selection
  const hasSelection = selection.selectedKeys.size > 0
  useEffect(() => {
    if (!hasSelection) {
      return
    }
    // Why window capture: the popover closes on Escape from a document capture listener, before React sees it.
    const clearOnEscape = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        !(event.target instanceof Node) ||
        !panelRef.current?.contains(event.target)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setAllSelected(false)
    }
    window.addEventListener('keydown', clearOnEscape, { capture: true })
    return () => window.removeEventListener('keydown', clearOnEscape, { capture: true })
  }, [hasSelection, setAllSelected])
  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((previous) => toggledSet(previous, key))
  }, [])
  const activate = useCallback(
    (row: ResourcePtyRow, event: React.MouseEvent) => {
      const modified = event.metaKey || event.ctrlKey || event.shiftKey
      if (modified && updateSelectionForGesture(event, row)) {
        return
      }
      setAllSelected(false)
      setOpenDetails((previous) => toggledSet(previous, row.identity))
    },
    [updateSelectionForGesture, setAllSelected]
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
  const { endMany } = actions
  const endAll = useCallback(
    (group: ResourcePtyGroup, source: Element) => {
      focusBodyBeforeEnd(source.closest('[data-resource-pty-group]'))
      void endMany(group.rows)
    },
    [endMany, focusBodyBeforeEnd]
  )
  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      {inventory.sessionsError && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-2xs text-destructive"
        >
          <AlertCircle aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">
            {t(
              'resourceManager.pty.refreshFailed',
              "Couldn't refresh. Showing last observed PTYs."
            )}
          </span>
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0 text-2xs text-foreground underline underline-offset-2"
            onClick={() => void inventory.refreshSessions()}
          >
            {t('resourceManager.pty.retry', 'Retry')}
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
            {t('resourceManager.pty.loading', 'Loading terminals…')}
          </p>
        )}
        {inventory.observedAt !== null && sessions.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">
            {t('resourceManager.pty.noLocalOrcaPtys', 'No local Orca PTYs')}
          </p>
        )}
        <ResourcePtyList
          items={items}
          scrollElement={scrollElement}
          observedAt={inventory.observedAt}
          unverifiable={inventory.sessionsError}
          ending={actions.ending}
          errors={actions.errors}
          selected={selection.selectedKeys}
          openDetails={openDetails}
          onToggleGroup={toggleGroup}
          onEndAll={endAll}
          onActivate={activate}
          onEnd={end}
          onNavigate={onNavigate}
        />
      </div>
      {selection.selectedItems.length > 0 && (
        <div className="flex h-[37px] shrink-0 items-center gap-1.5 border-t border-border px-3">
          <span className="text-xs tabular-nums">
            {t('resourceManager.pty.selectedCount', '{{count}} selected', {
              count: selection.selectedItems.length
            })}
          </span>
          <span className="flex-1" />
          <Button variant="ghost" size="xs" onClick={() => setAllSelected(false)}>
            {t('resourceManager.pty.clearSelection', 'Clear')}
          </Button>
          <Button
            variant="destructive"
            size="xs"
            onClick={(event) => {
              const focusedRow =
                event.currentTarget.ownerDocument.activeElement?.closest('[data-resource-pty-row]')
              focusBodyBeforeEnd(
                selection.selectedKeys.has(focusedRow?.getAttribute('data-resource-pty-row') ?? '')
                  ? (focusedRow ?? null)
                  : event.currentTarget
              )
              void endMany(selection.selectedItems)
            }}
          >
            {t('resourceManager.pty.endCount', 'End {{count}}', {
              count: selection.selectedItems.length
            })}
          </Button>
        </div>
      )}
    </div>
  )
}

function toggledSet(previous: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(previous)
  if (!next.delete(key)) {
    next.add(key)
  }
  return next
}
