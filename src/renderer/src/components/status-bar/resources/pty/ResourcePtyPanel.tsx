import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { useListMultiSelection } from '@/lib/list-interaction/use-list-multi-selection'
import { getSelectionIntent } from '@/lib/list-interaction/list-multi-selection'
import { useTranslate } from '@/i18n/use-translate'
import type { PtyRunningWorkObservation } from '../../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import {
  buildResourcePtyRows,
  groupResourcePtyRows,
  resourcePtyRowLabel,
  type ResourcePtyGroup,
  type ResourcePtyRow
} from './resource-pty-view-model'
import { ResourcePtyList, type ResourcePtyListItem } from './ResourcePtyList'
import { ResourcePtyEndAnnouncements } from './ResourcePtyEndAnnouncements'
import type { useResourceSessionInventory } from '../inventory/use-resource-session-inventory'
import { canEndResourcePty, type useResourcePtyActions } from './use-resource-pty-actions'
import { useResourcePtyEndableGroups } from './use-resource-pty-endable-groups'
import { useResourcePtyWorkspaceCheck } from './resource-pty-running-work'

const EMPTY_PTY_ROWS: ReturnType<typeof buildResourcePtyRows> = []
const subscribeInactive = (): (() => void) => () => {}
const ptyRowKey = (row: ResourcePtyRow): string => row.identity

export type ResourcePtyEndAllConfirmation = {
  rows: readonly ResourcePtyRow[]
  runningCount: number
  unverifiableCount: number
}

type Props = Omit<Parameters<typeof buildResourcePtyRows>[0], 'sessions'> & {
  active: boolean
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  liveTabs: Parameters<typeof resourcePtyRowLabel>[2]
  inventory: ReturnType<typeof useResourceSessionInventory>
  actions: ReturnType<typeof useResourcePtyActions>
  onNavigate: (tabId: string, paneKey: string | null) => void
  onConfirmEndAll: (confirmation: ResourcePtyEndAllConfirmation) => void
}

export function ResourcePtyPanel({
  active,
  inventory,
  actions,
  onNavigate,
  onConfirmEndAll,
  bindings,
  worktrees,
  repos,
  projectGroups,
  runtimePaneTitlesByTabId,
  liveTabs
}: Props) {
  const t = useTranslate()
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const getScope = useCallback(() => panelRef.current, [])
  const { sessions } = inventory.sessionInventory
  const { end: endPty, endMany, status } = actions
  const { sessionsError } = inventory
  const rows = useMemo(
    () =>
      active
        ? buildResourcePtyRows({
            bindings,
            worktrees,
            repos,
            projectGroups,
            sessions
          })
        : EMPTY_PTY_ROWS,
    [active, sessions, bindings, worktrees, repos, projectGroups]
  )
  const groups = useMemo(() => groupResourcePtyRows(rows), [rows])
  const labelForRow = useCallback(
    (row: ResourcePtyRow) =>
      resourcePtyRowLabel(row, runtimePaneTitlesByTabId, liveTabs, bindings.terminalLayoutsByTabId),
    [bindings.terminalLayoutsByTabId, liveTabs, runtimePaneTitlesByTabId]
  )
  const endableGroups = useResourcePtyEndableGroups(groups, status)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(() => new Set())
  const [previousGroups, setPreviousGroups] = useState(groups)
  if (groups !== previousGroups) {
    setPreviousGroups(groups)
    // Why: the inactive view projects an empty list. Only a real inventory projection retires keys.
    if (active) {
      if (openGroups.size > 0) {
        setOpenGroups(
          retainPresentKeys(
            openGroups,
            groups.map((group) => group.key)
          )
        )
      }
      if (openDetails.size > 0) {
        setOpenDetails(retainPresentKeys(openDetails, rows.map(ptyRowKey)))
      }
    }
  }
  const items = useMemo(() => {
    const list: ResourcePtyListItem[] = []
    for (const group of groups) {
      const open = openGroups.has(group.key)
      list.push({ kind: 'group', key: group.key, group, open })
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
      }
    }
    return list
  }, [groups, openGroups])
  const selectableRows = useMemo(() => {
    if (sessionsError) {
      return EMPTY_PTY_ROWS
    }
    const selectable: ResourcePtyRow[] = []
    for (const item of items) {
      if (item.kind === 'session' && canEndResourcePty(item.row)) {
        selectable.push(item.row)
      }
    }
    return selectable
  }, [items, sessionsError])
  const canSelectKey = useSyncExternalStore(
    active ? status.subscribeSelection : subscribeInactive,
    status.getSelectionCheck
  )
  const findRow = useMemo(() => {
    let rowsByKey: Map<string, ResourcePtyRow> | undefined
    return (key: string) => {
      rowsByKey ??= new Map(rows.map((row) => [row.identity, row]))
      return rowsByKey.get(key)
    }
  }, [rows])
  const getRetainedItem = useCallback(
    (key: string) => {
      if (sessionsError) {
        return undefined
      }
      const row = findRow(key)
      return row && canEndResourcePty(row) ? row : undefined
    },
    [findRow, sessionsError]
  )
  const selection = useListMultiSelection({
    items: selectableRows,
    getKey: ptyRowKey,
    getScope,
    getRetainedItem,
    canSelectKey,
    additiveRange: true
  })
  const { clearSelection, updateSelectionForGesture } = selection
  const hasSelection = selection.selectedKeys.size > 0
  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((previous) => toggledSet(previous, key))
  }, [])
  const activate = useCallback(
    (row: ResourcePtyRow, event: React.MouseEvent, canSelect: boolean) => {
      if (getSelectionIntent(event, navigator.userAgent.includes('Mac')) !== 'replace') {
        if (canSelect) {
          updateSelectionForGesture(event, row)
        }
        return
      }
      clearSelection(canSelect ? row : undefined)
      setOpenDetails((previous) => toggledSet(previous, row.identity))
    },
    [clearSelection, updateSelectionForGesture]
  )
  const focusBody = useCallback(
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
  useEffect(() => {
    if (!hasSelection) {
      return
    }
    // Why window capture: the popover closes on Escape from a document capture listener, before React sees it.
    const clearOnEscape = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        !(event.target instanceof Element) ||
        !panelRef.current?.contains(event.target)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      focusBody(event.target.closest('[data-resource-pty-selection]'))
      clearSelection()
    }
    window.addEventListener('keydown', clearOnEscape, { capture: true })
    return () => window.removeEventListener('keydown', clearOnEscape, { capture: true })
  }, [hasSelection, focusBody, clearSelection])
  const end = useCallback(
    (row: ResourcePtyRow) => {
      const focusedRow =
        panelRef.current?.ownerDocument.activeElement?.closest('[data-resource-pty-row]')
      focusBody(
        focusedRow?.getAttribute('data-resource-pty-row') === row.identity ? focusedRow : null
      )
      endPty(row)
    },
    [endPty, focusBody]
  )
  const finishWorkspaceCheck = useLatestHandler(
    (
      targets: readonly ResourcePtyRow[],
      observations: ReadonlyMap<string, PtyRunningWorkObservation>
    ) => {
      if (!active || sessionsError) {
        return
      }
      const rows = targets.filter((row) => {
        const current = findRow(row.identity)
        return !!current && canEndResourcePty(current) && status.isSelectable(row.identity)
      })
      let runningCount = 0
      let unverifiableCount = 0
      for (const row of rows) {
        const observation = observations.get(row.identity)
        if (observation === 'running') {
          runningCount += 1
        } else if (observation !== 'idle') {
          unverifiableCount += 1
        }
      }
      if (runningCount > 0 || unverifiableCount > 0) {
        onConfirmEndAll({ rows, runningCount, unverifiableCount })
      } else {
        void endMany(rows, 'idle')
      }
    }
  )
  const { checkingGroup, start } = useResourcePtyWorkspaceCheck(active, finishWorkspaceCheck)
  const endAll = useLatestHandler((group: ResourcePtyGroup, source: Element) => {
    if (!active || sessionsError || (group.kind === 'workspace' && checkingGroup !== null)) {
      return
    }
    focusBody(source.closest('[data-resource-pty-group]'))
    setOpenGroups((previous) =>
      previous.has(group.key) ? previous : new Set([...previous, group.key])
    )
    if (group.kind === 'unbound') {
      void endMany(group.rows, 'agent')
      return
    }
    const targets = group.rows.filter(
      (row) => canEndResourcePty(row) && status.isSelectable(row.identity)
    )
    start(group.key, targets)
  })
  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      {active && <ResourcePtyEndAnnouncements status={status} />}
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
          status={status}
          endableGroups={endableGroups}
          checkingGroup={checkingGroup}
          labelForRow={labelForRow}
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
        <div
          data-resource-pty-selection
          className="flex h-[37px] shrink-0 items-center gap-1.5 border-t border-border px-3"
        >
          <span className="text-xs tabular-nums">
            {t('resourceManager.pty.selectedCount', '{{count}} selected', {
              count: selection.selectedItems.length
            })}
          </span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="xs"
            onClick={(event) => {
              focusBody(event.currentTarget)
              clearSelection()
            }}
          >
            {t('resourceManager.pty.clearSelection', 'Clear')}
          </Button>
          <Button
            variant="destructive"
            size="xs"
            onClick={(event) => {
              const focusedRow =
                event.currentTarget.ownerDocument.activeElement?.closest('[data-resource-pty-row]')
              focusBody(
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

function retainPresentKeys(
  previous: ReadonlySet<string>,
  currentKeys: Iterable<string>
): ReadonlySet<string> {
  const retained = new Set<string>()
  for (const key of currentKeys) {
    if (previous.has(key)) {
      retained.add(key)
    }
  }
  return retained.size === previous.size ? previous : retained
}

function toggledSet(previous: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(previous)
  if (!next.delete(key)) {
    next.add(key)
  }
  return next
}
