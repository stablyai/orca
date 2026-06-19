import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@/store'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { GlpiServer, GlpiTicket, TaskProvider } from '../../../shared/types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import {
  findTaskPageGlpiTicket,
  isGlpiTicketStillDisplayed
} from '@/components/task-page-glpi-cache-selectors'
import { getGlpiTicketWorkspaceSeed } from '@/components/task-page-glpi-presentation'
import type { GlpiPresetId } from '@/components/task-page-localized-options'
import {
  useGlpiWorkItemFilters,
  type GlpiAdvancedFilters,
  type GlpiTypeFilter
} from '@/components/task-page-glpi-filters'

const GLPI_ITEM_LIMIT = 50

export type UseTaskPageGlpiArgs = {
  taskSource: TaskProvider
  taskResumeApplied: boolean
  providerRuntimeContextKey: string
  accountBackedTaskSourceHostId: ExecutionHostScope
  fallbackTaskSourceProjectId: string
  openTaskPage: (
    data?: { taskSource?: TaskProvider },
    options?: { recordTasksInteraction?: boolean }
  ) => void
  openModal: (modal: 'new-workspace-composer', payload?: Record<string, unknown>) => void
}

export type UseTaskPageGlpiResult = {
  glpiConnected: boolean
  glpiStatusReady: boolean
  glpiCredentialError: string | null
  glpiServers: GlpiServer[]
  selectedGlpiServerId: string | null
  selectedGlpiServer: GlpiServer | null
  glpiServerName: string | null
  glpiTaskSourceContext: TaskSourceContext | null
  glpiTickets: GlpiTicket[]
  glpiLoading: boolean
  glpiError: string | null
  activeGlpiPreset: GlpiPresetId
  setActiveGlpiPreset: (preset: GlpiPresetId) => void
  glpiTypeFilter: GlpiTypeFilter
  setGlpiTypeFilter: (type: GlpiTypeFilter) => void
  glpiAdvancedFilters: GlpiAdvancedFilters
  setGlpiAdvancedFilters: (filters: GlpiAdvancedFilters) => void
  glpiHasActiveFilters: boolean
  glpiRefreshNonce: number
  refreshGlpiTickets: () => void
  selectedGlpiTicket: GlpiTicket | null
  selectedGlpiTicketId: number | null
  glpiDetailSourceContext: TaskSourceContext | null
  openGlpiDetailPage: (ticket: GlpiTicket) => void
  clearSelectedGlpiTicket: () => void
  handleUseGlpiTicket: (ticket: GlpiTicket) => void
  selectGlpiServerById: (serverId: string) => void
}

// Why: GLPI behaves like Jira (account-based, multi-server) in TaskPage. This
// hook owns all GLPI list/detail state, effects and handlers so TaskPage.tsx
// stays focused on rendering and doesn't grow the already-large file further.
export function useTaskPageGlpi(args: UseTaskPageGlpiArgs): UseTaskPageGlpiResult {
  const {
    taskSource,
    taskResumeApplied,
    providerRuntimeContextKey,
    accountBackedTaskSourceHostId,
    fallbackTaskSourceProjectId,
    openTaskPage,
    openModal
  } = args

  const glpiStatus = useAppStore((s) => s.glpiStatus)
  const glpiStatusChecked = useAppStore((s) => s.glpiStatusChecked)
  const glpiStatusContextKey = useAppStore((s) => s.glpiStatusContextKey)
  const checkGlpiConnection = useAppStore((s) => s.checkGlpiConnection)
  const selectGlpiServer = useAppStore((s) => s.selectGlpiServer)
  const listGlpiWorkItems = useAppStore((s) => s.listGlpiWorkItems)
  const glpiCacheSnapshot = useAppStore(
    useShallow((s) => ({
      ticketCache: s.glpiTicketCache,
      listCache: s.glpiListCache
    }))
  )

  const glpiStatusCurrent = glpiStatusContextKey === providerRuntimeContextKey
  const glpiStatusReady = glpiStatusCurrent && glpiStatusChecked
  const glpiConnected = glpiStatusCurrent && glpiStatus.connected
  const glpiCredentialError = glpiStatus.credentialError ?? null

  const glpiServers = glpiStatus.servers ?? []
  const selectedGlpiServerSelection =
    glpiStatus.selectedServerId ?? glpiStatus.activeServerId ?? glpiServers[0]?.id ?? null
  const selectedGlpiServerId =
    selectedGlpiServerSelection && selectedGlpiServerSelection !== 'all'
      ? selectedGlpiServerSelection
      : null
  const selectedGlpiServer =
    selectedGlpiServerId !== null
      ? (glpiServers.find((server) => server.id === selectedGlpiServerId) ?? null)
      : null
  const glpiServerName = selectedGlpiServer?.displayName ?? selectedGlpiServer?.account ?? null

  const glpiTaskSourceContext = useMemo(
    () =>
      normalizeTaskSourceContext({
        provider: 'glpi',
        projectId: fallbackTaskSourceProjectId,
        hostId: accountBackedTaskSourceHostId,
        providerIdentity: {
          provider: 'glpi',
          serverId: selectedGlpiServerId,
          serverUrl: selectedGlpiServer?.baseUrl ?? null
        },
        accountLabel: glpiServerName
      }),
    [
      accountBackedTaskSourceHostId,
      fallbackTaskSourceProjectId,
      glpiServerName,
      selectedGlpiServer,
      selectedGlpiServerId
    ]
  )

  const [glpiTickets, setGlpiTickets] = useState<GlpiTicket[]>([])
  const [glpiLoading, setGlpiLoading] = useState(false)
  const [glpiError, setGlpiError] = useState<string | null>(null)
  // GLPI preset/selection are local-only: the shared TaskResumeState type has no
  // GLPI fields, so unlike Jira we don't persist them across sessions here.
  const [activeGlpiPreset, setActiveGlpiPreset] = useState<GlpiPresetId>('assigned')
  const {
    glpiTypeFilter,
    setGlpiTypeFilter,
    glpiAdvancedFilters,
    setGlpiAdvancedFilters,
    glpiHasActiveFilters,
    derivedGlpiFilters
  } = useGlpiWorkItemFilters()
  const [glpiRefreshNonce, setGlpiRefreshNonce] = useState(0)
  const [selectedGlpiTicketId, setSelectedGlpiTicketId] = useState<number | null>(null)
  const [selectedGlpiTicketFallback, setSelectedGlpiTicketFallback] = useState<GlpiTicket | null>(
    null
  )

  const refreshGlpiTickets = useCallback(() => setGlpiRefreshNonce((n) => n + 1), [])

  const cachedSelectedGlpiTicket = findTaskPageGlpiTicket(
    glpiCacheSnapshot.ticketCache,
    glpiCacheSnapshot.listCache,
    selectedGlpiTicketId,
    { sourceContext: glpiTaskSourceContext, serverId: selectedGlpiTicketFallback?.serverId ?? null }
  )
  const selectedGlpiTicket =
    selectedGlpiTicketId !== null ? (cachedSelectedGlpiTicket ?? selectedGlpiTicketFallback) : null
  const glpiDetailSourceContext = glpiTaskSourceContext

  const displayedGlpiTickets = useMemo(
    () =>
      glpiTickets.map(
        (ticket) =>
          findTaskPageGlpiTicket(
            glpiCacheSnapshot.ticketCache,
            glpiCacheSnapshot.listCache,
            ticket.id,
            { sourceContext: glpiTaskSourceContext, serverId: ticket.serverId ?? null }
          ) ?? ticket
      ),
    [glpiTickets, glpiCacheSnapshot.ticketCache, glpiCacheSnapshot.listCache, glpiTaskSourceContext]
  )

  const clearSelectedGlpiTicket = useCallback(() => {
    setSelectedGlpiTicketId(null)
    setSelectedGlpiTicketFallback(null)
  }, [])

  const openGlpiDetailPage = useCallback(
    (ticket: GlpiTicket) => {
      setSelectedGlpiTicketId(ticket.id)
      setSelectedGlpiTicketFallback(ticket)
      openTaskPage({ taskSource: 'glpi' }, { recordTasksInteraction: false })
    },
    [openTaskPage]
  )

  const handleUseGlpiTicket = useCallback(
    (ticket: GlpiTicket): void => {
      // GLPI is account-scoped: tag the provider so the link survives a project
      // change and drives the launch prompt; bare title avoids a doubled `#id`.
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'glpi',
        number: ticket.id,
        title: ticket.title,
        url: ticket.url
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext: glpiTaskSourceContext,
        prefilledName: getGlpiTicketWorkspaceSeed(ticket),
        telemetrySource: 'sidebar'
      })
    },
    [glpiTaskSourceContext, openModal]
  )

  const selectGlpiServerById = useCallback(
    (serverId: string) => {
      clearSelectedGlpiTicket()
      setGlpiTickets([])
      setGlpiError(null)
      setGlpiLoading(true)
      void selectGlpiServer(serverId)
    },
    [clearSelectedGlpiTicket, selectGlpiServer]
  )

  // Mirror the Jira connection-check effect: hydrate GLPI status on mount.
  useEffect(() => {
    if (!glpiStatusReady) {
      void checkGlpiConnection()
    }
  }, [checkGlpiConnection, glpiStatusContextKey, glpiStatusReady, providerRuntimeContextKey])

  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'glpi' || !glpiConnected) {
      return
    }
    let cancelled = false
    setGlpiLoading(true)
    setGlpiError(null)
    // GlpiPresetId is structurally the runtime GlpiTicketFilter union.
    void listGlpiWorkItems(activeGlpiPreset, GLPI_ITEM_LIMIT, derivedGlpiFilters, {
      sourceContext: glpiTaskSourceContext
    })
      .then((tickets) => {
        if (cancelled) {
          return
        }
        setGlpiTickets(tickets)
        setGlpiLoading(false)
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        setGlpiError(err instanceof Error ? err.message : 'Failed to load GLPI tickets.')
        setGlpiLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskSource,
    glpiConnected,
    selectedGlpiServerId,
    activeGlpiPreset,
    derivedGlpiFilters,
    glpiRefreshNonce,
    taskResumeApplied,
    glpiTaskSourceContext
  ])

  // Prune a stale selected ticket when it leaves the visible list.
  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'glpi') {
      return
    }
    if (!glpiConnected || displayedGlpiTickets.length === 0) {
      if (selectedGlpiTicketId !== null || selectedGlpiTicketFallback !== null) {
        clearSelectedGlpiTicket()
      }
      return
    }
    const serverId = selectedGlpiTicketFallback?.serverId ?? null
    if (
      selectedGlpiTicketId !== null &&
      !isGlpiTicketStillDisplayed(displayedGlpiTickets, selectedGlpiTicketId, serverId)
    ) {
      clearSelectedGlpiTicket()
    }
  }, [
    clearSelectedGlpiTicket,
    displayedGlpiTickets,
    glpiConnected,
    selectedGlpiTicketFallback,
    selectedGlpiTicketId,
    taskResumeApplied,
    taskSource
  ])

  return {
    glpiConnected,
    glpiStatusReady,
    glpiCredentialError,
    glpiServers,
    selectedGlpiServerId,
    selectedGlpiServer,
    glpiServerName,
    glpiTaskSourceContext,
    glpiTickets: displayedGlpiTickets,
    glpiLoading,
    glpiError,
    activeGlpiPreset,
    setActiveGlpiPreset,
    glpiTypeFilter,
    setGlpiTypeFilter,
    glpiAdvancedFilters,
    setGlpiAdvancedFilters,
    glpiHasActiveFilters,
    glpiRefreshNonce,
    refreshGlpiTickets,
    selectedGlpiTicket,
    selectedGlpiTicketId,
    glpiDetailSourceContext,
    openGlpiDetailPage,
    clearSelectedGlpiTicket,
    handleUseGlpiTicket,
    selectGlpiServerById
  }
}
