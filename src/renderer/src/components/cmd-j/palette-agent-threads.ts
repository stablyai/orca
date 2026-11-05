import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import {
  canonicalOrchestrationForRow,
  selectVisibleAgentOrchestration
} from '@/runtime/visible-agent-orchestration'
import { useStructuredChatTabNames } from '@/runtime/structured-chat-name-observation'
import type { StructuredChatTabNames } from '@/runtime/structured-chat-tab-name'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { buildActivityEvents } from '../activity/activity-event-builder'
import { freshActivityLiveAgentState } from '../activity/activity-event-state'
import { buildAgentPaneThreads } from '../activity/activity-thread-builder'
import type { AgentPaneThread } from '../activity/activity-thread-types'

const NO_THREADS: readonly AgentPaneThread[] = []

function paneRecords<T>(records: Record<string, T>, rows: readonly AgentPaneThread[]) {
  const selected: Record<string, T> = {}
  for (const { paneKey } of rows) {
    if (records[paneKey] !== undefined) {
      selected[paneKey] = records[paneKey]
    }
  }
  return selected
}

/** Use the same Activity semantics for both the uncapped membership capture and bounded live rows. */
export function buildPaletteAgentThreads(
  state: AppState,
  chatNames: StructuredChatTabNames,
  rows?: readonly AgentPaneThread[]
): AgentPaneThread[] {
  const tabsByWorktree: AppState['tabsByWorktree'] = {}
  const unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] = {}
  const migrationUnsupportedByPtyId: AppState['migrationUnsupportedByPtyId'] = {}
  if (rows) {
    const rowTabIds = new Set(rows.map((row) => row.tab.id))
    for (const row of rows) {
      const worktreeId = row.worktree.id
      // Why: rows sharing a workspace need its sibling tabs filtered once, not once per row.
      if (!Object.hasOwn(tabsByWorktree, worktreeId)) {
        tabsByWorktree[worktreeId] = (state.tabsByWorktree[worktreeId] ?? []).filter((tab) =>
          rowTabIds.has(tab.id)
        )
        unifiedTabsByWorktree[worktreeId] = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
          (tab) => rowTabIds.has(tab.contentType === 'terminal' ? tab.entityId : tab.id)
        )
      }
      const ptyId = row.migrationUnsupportedPtyId ?? row.tab.ptyId
      if (ptyId && state.migrationUnsupportedByPtyId[ptyId]) {
        migrationUnsupportedByPtyId[ptyId] = state.migrationUnsupportedByPtyId[ptyId]
      }
    }
  }
  const events = buildActivityEvents({
    chatNames,
    agentStatusByPaneKey: rows
      ? paneRecords(state.agentStatusByPaneKey, rows)
      : state.agentStatusByPaneKey,
    runtimeAgentOrchestrationByPaneKey: rows
      ? Object.fromEntries(
          rows.flatMap(({ paneKey }) => {
            const context = canonicalOrchestrationForRow(state, paneKey)
            return context ? [[paneKey, context]] : []
          })
        )
      : selectVisibleAgentOrchestration(state),
    retainedAgentsByPaneKey: rows
      ? paneRecords(state.retainedAgentsByPaneKey, rows)
      : state.retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId: rows
      ? migrationUnsupportedByPtyId
      : state.migrationUnsupportedByPtyId,
    tabsByWorktree: rows ? tabsByWorktree : state.tabsByWorktree,
    unifiedTabsByWorktree: rows ? unifiedTabsByWorktree : state.unifiedTabsByWorktree,
    worktreeMap: rows ? new Map() : getWorktreeMapFromState(state),
    repoMap: getRepoMapFromState(state),
    repos: state.repos,
    resolveWorktree: state.getKnownWorktreeById,
    acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
    now: Date.now(),
    capHistory: false
  })
  return buildAgentPaneThreads({
    ...events,
    generatedTitlesEnabled: state.settings?.tabAutoGenerateTitle === true
  })
}

export function usePaletteAgentThreads(rows: readonly AgentPaneThread[], enabled: boolean) {
  const activeRows = enabled ? rows : NO_THREADS
  const inputs = useAppStore(
    useShallow((state) =>
      activeRows.length === 0
        ? []
        : [
            state.settings?.tabAutoGenerateTitle,
            state.repos,
            ...activeRows.flatMap((row) => {
              const entry = state.agentStatusByPaneKey[row.paneKey]
              const ptyId = row.migrationUnsupportedPtyId ?? row.tab.ptyId
              return [
                entry,
                entry
                  ? freshActivityLiveAgentState(
                      entry,
                      getAgentStatusEpochNow(state.agentStatusEpoch)
                    )
                  : null,
                state.retainedAgentsByPaneKey[row.paneKey],
                canonicalOrchestrationForRow(state, row.paneKey),
                state.acknowledgedAgentsByPaneKey[row.paneKey],
                state.activityClearedAtByPaneKey[row.paneKey],
                ptyId ? state.migrationUnsupportedByPtyId[ptyId] : undefined,
                state.tabsByWorktree[row.worktree.id],
                state.unifiedTabsByWorktree[row.worktree.id],
                state.getKnownWorktreeById(
                  row.worktree.id,
                  getWorktreeExecutionHostId(row.worktree, row.repo ?? undefined)
                )
              ]
            })
          ]
    )
  )
  const chatNames = useStructuredChatTabNames()
  return useMemo(
    () =>
      new Map(
        (activeRows.length > 0
          ? buildPaletteAgentThreads(useAppStore.getState(), chatNames, activeRows)
          : NO_THREADS
        ).map((thread) => [thread.paneKey, thread])
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Only the selected rows' store inputs invalidate their live projection.
    [activeRows, inputs, chatNames]
  )
}
