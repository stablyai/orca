import { useEffect } from 'react'
import { useAppStore, type AppState } from '@/store'
import { buildDashboardSnapshot } from '@/components/dashboard/build-dashboard-snapshot'
import { createWorktreeAgentRowsCache } from '@/components/dashboard/worktree-agent-rows-cache'
import { revealDashboardAgent } from '@/components/dashboard/reveal-dashboard-agent'
import { isWebClientLocation } from '@/lib/web-client-location'
import type { DashboardCard, DashboardSnapshot } from '../../../shared/dashboard-snapshot'
import {
  MAX_DOCK_AGENT_LABEL_LENGTH,
  type DockAgentEntry,
  type DockAgentMenuPayload
} from '../../../shared/dock-agent-menu'

const DOCK_AGENT_MENU_THROTTLE_MS = 200

type DockAgentMenuWatchState = AppState

function normalizedLabel(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function boundedLabel(value: string): string {
  let result = ''
  for (const character of normalizedLabel(value)) {
    if (result.length + character.length > MAX_DOCK_AGENT_LABEL_LENGTH) {
      break
    }
    result += character
  }
  return result
}

function dockAgentEntryId(card: DashboardCard): string {
  return [card.executionHostId ?? 'local', card.repoId, card.worktreeId, card.paneKey].join(':')
}

function dockAgentLabel(card: DashboardCard, duplicateLabels: Map<string, number>): string {
  const agentLabel =
    card.conversationName?.trim() ||
    card.task.trim() ||
    card.lastUserMessage?.trim() ||
    card.agentType
  const location = [card.repoName.trim(), card.worktreeName.trim()].filter(Boolean).join(' / ')
  const base = boundedLabel([location, agentLabel].filter(Boolean).join(' · ')) || card.agentType
  const count = duplicateLabels.get(base) ?? 0
  duplicateLabels.set(base, count + 1)
  if (count === 0) {
    return base
  }
  const suffix = ` (${count + 1})`
  let prefix = ''
  for (const character of base) {
    if (prefix.length + character.length + suffix.length > MAX_DOCK_AGENT_LABEL_LENGTH) {
      break
    }
    prefix += character
  }
  return `${prefix}${suffix}`
}

function dockAgentEntry(card: DashboardCard, duplicateLabels: Map<string, number>): DockAgentEntry {
  return {
    id: dockAgentEntryId(card),
    label: dockAgentLabel(card, duplicateLabels),
    target: {
      repoId: card.repoId,
      worktreeId: card.worktreeId,
      ...(card.executionHostId ? { executionHostId: card.executionHostId } : {}),
      tabId: card.tabId,
      leafId: card.leafId
    }
  }
}

function selectEntries(
  cards: readonly DashboardCard[],
  predicate: (card: DashboardCard) => boolean
): DockAgentEntry[] {
  const duplicateLabels = new Map<string, number>()
  const seenIds = new Set<string>()
  const entries: DockAgentEntry[] = []
  for (const card of cards) {
    if (!predicate(card)) {
      continue
    }
    const entry = dockAgentEntry(card, duplicateLabels)
    if (seenIds.has(entry.id)) {
      continue
    }
    seenIds.add(entry.id)
    entries.push(entry)
  }
  return entries
}

/** Projects the shared Dashboard snapshot onto the compact macOS Dock menu contract. */
export function buildDockAgentMenuPayload(
  snapshot: Pick<DashboardSnapshot, 'cards'>,
  unreadTerminalTabs: Readonly<Record<string, unknown>> = {}
): DockAgentMenuPayload {
  const active = selectEntries(
    snapshot.cards,
    (card) =>
      card.startedAt !== 0 &&
      (card.dotState === 'working' || card.dotState === 'blocked' || card.dotState === 'waiting')
  )
  const unread = selectEntries(
    snapshot.cards,
    (card) => card.unseen || unreadTerminalTabs[card.tabId] !== undefined
  )
  return { active, unread }
}

function dockSnapshotInputsChanged(
  state: DockAgentMenuWatchState,
  previousState: DockAgentMenuWatchState
): boolean {
  return (
    state.agentStatusByPaneKey !== previousState.agentStatusByPaneKey ||
    state.agentStatusEpoch !== previousState.agentStatusEpoch ||
    state.unreadTerminalTabs !== previousState.unreadTerminalTabs ||
    state.repos !== previousState.repos ||
    state.worktreesByRepo !== previousState.worktreesByRepo ||
    state.folderWorkspaces !== previousState.folderWorkspaces ||
    state.projectGroups !== previousState.projectGroups ||
    state.tabsByWorktree !== previousState.tabsByWorktree ||
    state.unifiedTabsByWorktree !== previousState.unifiedTabsByWorktree ||
    state.retainedAgentsByPaneKey !== previousState.retainedAgentsByPaneKey ||
    state.migrationUnsupportedByPtyId !== previousState.migrationUnsupportedByPtyId ||
    state.runtimeAgentOrchestrationByPaneKey !== previousState.runtimeAgentOrchestrationByPaneKey ||
    state.terminalLayoutsByTabId !== previousState.terminalLayoutsByTabId ||
    state.ptyIdsByTabId !== previousState.ptyIdsByTabId ||
    state.runtimePaneTitlesByTabId !== previousState.runtimePaneTitlesByTabId ||
    state.paneForegroundAgentByPaneKey !== previousState.paneForegroundAgentByPaneKey ||
    state.acknowledgedAgentsByPaneKey !== previousState.acknowledgedAgentsByPaneKey ||
    state.settings?.tabAutoGenerateTitle !== previousState.settings?.tabAutoGenerateTitle
  )
}

/** Keeps the native macOS Dock menu in sync with the main renderer's agent state. */
export function useDockAgentMenu(): void {
  useEffect(() => {
    if (isWebClientLocation() || window.api.platform.get().platform !== 'darwin') {
      return
    }

    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const rowsCache = createWorktreeAgentRowsCache()
    const appApi = window.api.app
    if (
      typeof appApi.setDockAgentMenu !== 'function' ||
      typeof appApi.onOpenDockAgent !== 'function'
    ) {
      return
    }
    const publish = (): void => {
      if (disposed) {
        return
      }
      const state = useAppStore.getState()
      const snapshot = buildDashboardSnapshot(state, Date.now(), {
        includeCardDetails: false,
        includeFilterOptions: false,
        includeExecutionHostId: true,
        rowsCache,
        rowsGeneration: state.agentStatusEpoch
      })
      void appApi
        .setDockAgentMenu(buildDockAgentMenuPayload(snapshot, state.unreadTerminalTabs))
        .catch(() => undefined)
    }
    const schedulePublish = (): void => {
      if (disposed || timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        publish()
      }, DOCK_AGENT_MENU_THROTTLE_MS)
    }
    const unsubscribe = useAppStore.subscribe((state, previousState) => {
      if (dockSnapshotInputsChanged(state, previousState)) {
        schedulePublish()
      }
    })
    const unsubscribeOpen = appApi.onOpenDockAgent((args) => {
      // The native main process validates membership before sending this event;
      // reuse the same activation path as the dashboard surfaces.
      revealDashboardAgent(args)
    })
    publish()

    return () => {
      disposed = true
      unsubscribe()
      unsubscribeOpen()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [])
}
