import React, { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'

import { OdooIcon } from '@/components/icons/OdooIcon'
import { OdooConnectDialog } from '@/components/odoo-connect-dialog'
import { OdooTicketWorkspace } from '@/components/odoo-ticket-workspace'
import {
  DEFAULT_ODOO_TICKET_FILTERS,
  deriveOdooTicketFacets,
  filterOdooTickets,
  type OdooTicketListFilters
} from '@/components/odoo-ticket-facets'
import {
  getDefaultSavedOdooTicketFilter,
  ODOO_SEEDED_FILTER_PRESETS,
  readOrSeedSavedOdooTicketFilters,
  removeSavedOdooTicketFilter,
  reorderSavedOdooTicketFilters,
  setDefaultSavedOdooTicketFilter,
  toggleSavedOdooTicketFilterPin,
  upsertSavedOdooTicketFilter,
  writeSavedOdooTicketFilters,
  type OdooSavedTicketFilter
} from '@/components/odoo-saved-ticket-filters'
import { OdooTicketKanban } from '@/components/odoo-ticket-kanban'
import { OdooTicketToolbar, type OdooTicketPanelView } from '@/components/odoo-ticket-toolbar'
import { OdooTicketRow } from '@/components/task-page-odoo-ticket-row'
import type { OdooTicketFilterId } from '@/components/odoo-ticket-filter-select'
import { getOdooPresets, getOdooPriorityLabels } from '@/components/task-page-localized-options'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import { useOdooAutoWorkspace } from '@/components/use-odoo-auto-workspace'
import {
  ODOO_TICKET_PANEL_REFRESH_INTERVAL_MS,
  shouldRunScheduledOdooRefresh
} from '@/components/odoo-ticket-panel-refresh-schedule'
import { translate } from '@/i18n/i18n'
import type { OdooTicket, OdooTicketFilter } from '../../../shared/odoo-types'
const VIEW_STORAGE_KEY = 'odoo.ticketPanelView'

// Kanban is the default: the stage columns are what the panel is for, and the
// list is the opt-in fallback.
function readStoredView(): OdooTicketPanelView {
  if (typeof window === 'undefined') {
    return 'kanban'
  }
  return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'kanban'
}

function odooPresetLabel(preset: OdooTicketFilter): string {
  return getOdooPresets().find((entry) => entry.id === preset)?.label ?? preset
}

export type TaskPageOdooPanelProps = { onHide?: () => void }

export function TaskPageOdooPanel({ onHide }: TaskPageOdooPanelProps): React.JSX.Element {
  const odooStatus = useAppStore((s) => s.odooStatus)
  const odooStatusChecked = useAppStore((s) => s.odooStatusChecked)
  const checkOdooConnection = useAppStore((s) => s.checkOdooConnection)
  const listOdooTickets = useAppStore((s) => s.listOdooTickets)
  const searchOdooTickets = useAppStore((s) => s.searchOdooTickets)
  const selectOdooInstance = useAppStore((s) => s.selectOdooInstance)

  // A starred saved filter is what the panel opens on, so it has to seed the
  // initial state rather than be applied after the first read fires.
  const initialSavedFilters = useRef(readOrSeedSavedOdooTicketFilters(odooPresetLabel)).current
  const initialDefault = getDefaultSavedOdooTicketFilter(initialSavedFilters)
  const [preset, setPreset] = useState<OdooTicketFilter>(initialDefault?.preset ?? 'assigned')
  const [searchInput, setSearchInput] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [tickets, setTickets] = useState<OdooTicket[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [connectOpen, setConnectOpen] = useState(false)
  const [selectedTicket, setSelectedTicket] = useState<OdooTicket | null>(null)
  // Client-side narrowing of the loaded set — instant and instance-agnostic.
  const [filters, setFilters] = useState<OdooTicketListFilters>(
    initialDefault?.filters ?? DEFAULT_ODOO_TICKET_FILTERS
  )
  // Only one filter menu may be open at a time; see OdooTicketFilterSelect.
  const [openFilter, setOpenFilter] = useState<OdooTicketFilterId>(null)
  const [savedFilters, setSavedFilters] = useState<OdooSavedTicketFilter[]>(initialSavedFilters)
  const [view, setView] = useState<OdooTicketPanelView>(readStoredView)
  // The Refresh button sets this so the next read bypasses the cache TTL.
  const maybeStartOdooAutoWorkspaces = useOdooAutoWorkspace()
  const forceNextReadRef = useRef(false)
  // Read inside the interval callback, which must not re-subscribe on every
  // load toggle. Mirrored in an effect rather than assigned during render:
  // render must stay pure, React may replay or discard it.
  const loadingRef = useRef(false)
  // The signed-in user seeds the assignee filter, but only once: switching
  // preset afterwards must not silently re-narrow the list back to them.
  // A starred filter is an explicit choice, so it outranks the viewer seed.
  const viewerAssigneeAppliedRef = useRef(initialDefault !== null)

  // Only the two starter presets are offered: the rest of the Jira-shared
  // vocabulary was noise here, and anything narrower belongs in a saved filter.
  const presets = getOdooPresets().filter((entry) => ODOO_SEEDED_FILTER_PRESETS.includes(entry.id))
  const priorityLabels = getOdooPriorityLabels()
  const instances = odooStatus.instances ?? []
  const selectedInstanceId = odooStatus.selectedInstanceId ?? odooStatus.activeInstanceId ?? null

  const resetFilters = (): void => setFilters(DEFAULT_ODOO_TICKET_FILTERS)
  const setFilter = <K extends keyof OdooTicketListFilters>(
    key: K,
    value: OdooTicketListFilters[K]
  ): void => setFilters((current) => ({ ...current, [key]: value }))

  const persistSavedFilters = (next: OdooSavedTicketFilter[]): void => {
    setSavedFilters(next)
    writeSavedOdooTicketFilters(next)
  }

  const facets = useMemo(() => deriveOdooTicketFacets(tickets), [tickets])
  const visibleTickets = useMemo(() => filterOdooTickets(tickets, filters), [tickets, filters])

  // Drives the ticket panel's prev/next pager — position within the same
  // filtered/sorted list the user is currently browsing, not the raw fetch.
  const selectedTicketIndex = selectedTicket
    ? visibleTickets.findIndex(
        (entry) => entry.id === selectedTicket.id && entry.instanceId === selectedTicket.instanceId
      )
    : -1
  const previousTicket = selectedTicketIndex > 0 ? visibleTickets[selectedTicketIndex - 1] : null
  const nextTicket =
    selectedTicketIndex >= 0 && selectedTicketIndex < visibleTickets.length - 1
      ? visibleTickets[selectedTicketIndex + 1]
      : null
  const ticketPosition =
    selectedTicketIndex >= 0 ? { index: selectedTicketIndex, total: visibleTickets.length } : null

  // Open on the signed-in user rather than "All assignees" — the first loaded
  // set is what tells us whether they actually appear in the facet.
  const viewerUid = odooStatus.viewer?.uid
  useEffect(() => {
    if (viewerAssigneeAppliedRef.current || viewerUid === undefined || tickets.length === 0) {
      return
    }
    viewerAssigneeAppliedRef.current = true
    if (facets.assignees.some((option) => option.id === viewerUid)) {
      setFilter('assignee', String(viewerUid))
    }
  }, [facets, tickets.length, viewerUid])

  useEffect(() => {
    void checkOdooConnection()
  }, [checkOdooConnection])

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  useEffect(() => {
    if (!odooStatus.connected) {
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const forceRefresh = forceNextReadRef.current
    forceNextReadRef.current = false
    const read = appliedSearch
      ? searchOdooTickets([['name', 'ilike', appliedSearch]], 50, { forceRefresh })
      : listOdooTickets(preset, 50, { forceRefresh })
    read
      .then((result) => {
        if (!cancelled) {
          setTickets(result)
          // Runs off the panel's own reads, so it can never fire more often
          // than the panel already talks to Odoo.
          maybeStartOdooAutoWorkspaces(result)
        }
      })
      .catch((readError: unknown) => {
        if (!cancelled) {
          setError(readError instanceof Error ? readError.message : String(readError))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    odooStatus.connected,
    selectedInstanceId,
    preset,
    appliedSearch,
    refreshNonce,
    listOdooTickets,
    searchOdooTickets,
    maybeStartOdooAutoWorkspaces
  ])

  // Unattended refresh. Reuses the Refresh button's exact path (force the next
  // read past the cache TTL, then bump the nonce) so there is one read path to
  // reason about rather than a second, subtly different one.
  useEffect(() => {
    if (!odooStatus.connected) {
      return
    }
    const timer = window.setInterval(() => {
      if (
        !shouldRunScheduledOdooRefresh({
          connected: useAppStore.getState().odooStatus.connected,
          windowVisible: isWindowVisible(),
          loading: loadingRef.current
        })
      ) {
        return
      }
      forceNextReadRef.current = true
      setRefreshNonce((n) => n + 1)
    }, ODOO_TICKET_PANEL_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [odooStatus.connected, selectedInstanceId])

  const patchListedTicket = (ticketId: number, patch: Partial<OdooTicket>): void => {
    setTickets((current) =>
      current.map((entry) => (entry.id === ticketId ? { ...entry, ...patch } : entry))
    )
    setSelectedTicket((current) => (current?.id === ticketId ? { ...current, ...patch } : current))
  }

  if (!odooStatusChecked) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!odooStatus.connected) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <OdooIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {translate('auto.components.task.page.odoo.panel.36a83d1d90', 'Connect your Odoo server')}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {translate(
            'auto.components.task.page.odoo.panel.c172248418',
            'Browse, edit, and comment on Odoo tickets directly from here.'
          )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setConnectOpen(true)}>
            {translate('auto.components.task.page.odoo.panel.d0e1575687', 'Connect Odoo')}
          </Button>
          {onHide ? (
            <Button variant="outline" onClick={onHide}>
              {translate('auto.components.task.page.odoo.panel.546376384c', 'Hide Odoo')}
            </Button>
          ) : null}
        </div>
        <OdooConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      </div>
    )
  }

  return (
    <div
      data-odoo-panel="true"
      className="mt-4 flex min-h-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm"
    >
      <OdooTicketToolbar
        presets={presets}
        preset={preset}
        presetActive={!appliedSearch}
        onPresetSelect={(next) => {
          setSearchInput('')
          setAppliedSearch('')
          setPreset(next)
          resetFilters()
        }}
        instances={instances}
        selectedInstanceId={selectedInstanceId}
        onInstanceSelect={(instanceId) => {
          setSelectedTicket(null)
          setTickets([])
          resetFilters()
          void selectOdooInstance(instanceId).catch(() => {
            toast.error(
              translate(
                'auto.components.task.page.odoo.panel.85e1148843',
                'Failed to switch Odoo instance.'
              )
            )
          })
        }}
        facets={facets}
        filters={filters}
        onFilterChange={setFilter}
        openFilter={openFilter}
        onOpenFilterChange={setOpenFilter}
        priorityLabels={priorityLabels}
        searchInput={searchInput}
        onSearchInputChange={setSearchInput}
        onSearchSubmit={() => {
          setAppliedSearch(searchInput.trim())
          resetFilters()
        }}
        loading={loading}
        onRefresh={() => {
          forceNextReadRef.current = true
          setRefreshNonce((n) => n + 1)
        }}
        savedFilters={savedFilters}
        onApplySavedFilter={(entry) => {
          // Recalling a saved view must also drop any active title search,
          // otherwise the server read stays pinned to the search results.
          setSearchInput('')
          setAppliedSearch('')
          setPreset(entry.preset)
          setFilters(entry.filters)
          // A recalled view is an explicit choice; don't let the viewer seed
          // overwrite its assignee on the next load.
          viewerAssigneeAppliedRef.current = true
        }}
        onSaveFilter={(name) =>
          persistSavedFilters(upsertSavedOdooTicketFilter(savedFilters, { name, preset, filters }))
        }
        onDeleteSavedFilter={(id) =>
          persistSavedFilters(removeSavedOdooTicketFilter(savedFilters, id))
        }
        onSetDefaultSavedFilter={(id) =>
          persistSavedFilters(setDefaultSavedOdooTicketFilter(savedFilters, id))
        }
        onTogglePinnedSavedFilter={(id) =>
          persistSavedFilters(toggleSavedOdooTicketFilterPin(savedFilters, id))
        }
        onReorderSavedFilters={(activeId, overId) =>
          persistSavedFilters(reorderSavedOdooTicketFilters(savedFilters, activeId, overId))
        }
        view={view}
        onViewChange={(next) => {
          setView(next)
          window.localStorage.setItem(VIEW_STORAGE_KEY, next)
        }}
      />

      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
        <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {translate('auto.components.task.page.odoo.panel.93d245553c', 'Odoo tickets')}
        </div>
        <div className="shrink-0 text-[11px] text-muted-foreground">
          {visibleTickets.length}{' '}
          {translate('auto.components.task.page.odoo.panel.42b63f8760', 'shown')}
        </div>
      </div>

      {odooStatus.credentialError ? (
        <div className="flex-none border-b border-border px-4 py-4 text-sm text-destructive">
          {odooStatus.credentialError}
        </div>
      ) : null}
      {!odooStatus.credentialError && error ? (
        <div className="flex-none border-b border-border px-4 py-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading && tickets.length === 0 ? (
        <div className="flex-none divide-y divide-border/50">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="px-3 py-3">
              <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
              <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
            </div>
          ))}
        </div>
      ) : null}

      {!loading && visibleTickets.length === 0 && !error && !odooStatus.credentialError ? (
        <div className="flex-none px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">
            {translate('auto.components.task.page.odoo.panel.f5975fc3d1', 'No tickets found')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.task.page.odoo.panel.7bb7235cda',
              'Try a different filter or search.'
            )}
          </p>
        </div>
      ) : null}

      {/* The kanban scrolls horizontally across stages and vertically inside
          each column, so it owns its own overflow instead of the list's. */}
      {view === 'kanban' ? (
        <OdooTicketKanban
          tickets={visibleTickets}
          selectedTicketId={selectedTicket?.id ?? null}
          selectedInstanceId={selectedTicket?.instanceId ?? null}
          showInstanceContext={instances.length > 1}
          onOpen={setSelectedTicket}
        />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
          style={{ scrollbarGutter: 'stable' }}
        >
          <div className="divide-y divide-border/50">
            {visibleTickets.map((ticket) => (
              <OdooTicketRow
                key={`${ticket.instanceId ?? ''}:${ticket.id}`}
                ticket={ticket}
                selected={selectedTicket?.id === ticket.id}
                showInstanceContext={instances.length > 1}
                onOpen={setSelectedTicket}
              />
            ))}
          </div>
        </div>
      )}

      <OdooTicketWorkspace
        ticket={selectedTicket}
        onClose={() => setSelectedTicket(null)}
        onTicketPatched={patchListedTicket}
        previousTicket={previousTicket}
        nextTicket={nextTicket}
        ticketPosition={ticketPosition}
        onNavigate={setSelectedTicket}
      />
    </div>
  )
}
