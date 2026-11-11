import { useAppStore } from '@/store/index'
import { resolveOwner } from '@/lib/workspace/ownership/resolve-owner'
import {
  retainedTerminalDestination,
  type RetainedTerminalDestination
} from '../../../../shared/workspace-layout/retained-terminal-destination'
import { canHoldRetainedTerminalStart } from './retained-terminal-start'
import { mergeRetainedGroupLayout, mergeRetainedPaneLayout } from './retained-destination-topology'
import { replaceRecordEntries, replaceTabBuckets } from '../keyed-record-transitions'
import type { TerminalStartupAttempt } from './terminal-startup-attempt'

export type RetainedDestinationDisposition = 'installed' | 'current' | 'superseded' | 'unresolved'

/** Facts and their addressed topology become visible in one publication. */
export function installRetainedTerminalDestination(
  destination: RetainedTerminalDestination,
  attempt?: TerminalStartupAttempt
): RetainedDestinationDisposition {
  const parsed = retainedTerminalDestination.safeParse(destination)
  if (!parsed.success) {
    return 'unresolved'
  }
  const { start, tab, layout, group, groupLayout } = parsed.data
  let disposition: RetainedDestinationDisposition = 'unresolved'
  useAppStore.setState((state) => {
    if (attempt && state.terminalStartupAttempt !== attempt) {
      return state
    }
    const currentAttempt = attempt ?? state.terminalStartupAttempt
    const address = { worktreeId: start.worktreeId, tabId: start.tabId, leafId: start.leafId }
    if (
      !canHoldRetainedTerminalStart(state, start, address) ||
      currentAttempt?.wasRetired(tab.id, start.leafId) ||
      currentAttempt?.wasRebound(tab.id, start.leafId)
    ) {
      disposition = 'superseded'
      return state
    }
    const hydratedHost = state.restoredRuntimeHostIdByWorkspaceSessionKey?.[start.worktreeId]
    if (hydratedHost && hydratedHost !== start.executionHostId) {
      return state
    }
    const ownership = resolveOwner(state, {
      workspaceId: start.worktreeId,
      hostId: start.executionHostId
    })
    if (
      ownership.kind !== 'resolved' ||
      ownership.owner.endpoint.kind !== 'self' ||
      ownership.owner.at !== start.executionHostId
    ) {
      return state
    }
    const key = `${tab.id}:${start.leafId}`
    const previous = state.terminalPaneStartsByPaneKey[key]?.retainedTerminalStart
    const sameFact =
      previous?.runtimeId === start.runtimeId &&
      previous.startSequence === start.startSequence &&
      previous.bindingGeneration === start.bindingGeneration &&
      previous.status === start.status &&
      previous.reason === start.reason
    const heldFacts = sameFact
      ? state.terminalPaneStartsByPaneKey
      : {
          ...state.terminalPaneStartsByPaneKey,
          [key]: { status: start.status, reason: start.reason, retainedTerminalStart: start }
        }
    const unresolved = () => {
      return sameFact ? state : { terminalPaneStartsByPaneKey: heldFacts }
    }
    const worktreeId = start.worktreeId
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    const currentTab = tabs.find((row) => row.id === tab.id)
    const currentLayout = state.terminalLayoutsByTabId[tab.id]
    const baseline = currentAttempt?.baselineTab(tab.id)
    const groups = state.groupsByWorktree[worktreeId] ?? []
    const currentGroup = groups.find((row) => row.tabOrder.includes(tab.id))
    if (
      baseline &&
      (!currentTab ||
        baseline.worktreeId !== worktreeId ||
        (baseline.groupId && currentGroup?.id !== baseline.groupId))
    ) {
      disposition = 'superseded'
      return state
    }
    // Existing current placement owns the view; prepare must never move it back to a host mirror.
    const targetGroupId = currentGroup?.id ?? group?.id
    if (!targetGroupId) {
      return unresolved()
    }
    const targetGroup = groups.find((row) => row.id === targetGroupId)
    if (!targetGroup && currentAttempt?.hadGroup(worktreeId, targetGroupId)) {
      disposition = 'superseded'
      return state
    }
    const nextGroupLayout = mergeRetainedGroupLayout(
      state.layoutByWorktree[worktreeId],
      groupLayout,
      targetGroupId
    )
    const nextLayout = mergeRetainedPaneLayout(currentLayout, layout, start.leafId)
    if (!nextLayout || !nextGroupLayout) {
      return unresolved()
    }
    currentAttempt?.settle(tab.id, start.leafId)
    const unified = state.unifiedTabsByWorktree[worktreeId] ?? []
    const existingUnified = unified.find(
      (row) => row.contentType === 'terminal' && row.entityId === tab.id
    )
    if (
      currentTab &&
      currentLayout === nextLayout &&
      sameFact &&
      targetGroup &&
      nextGroupLayout === state.layoutByWorktree[worktreeId] &&
      existingUnified
    ) {
      disposition = 'current'
      return state
    }
    const unifiedId = existingUnified?.id ?? tab.id
    // Only this terminal's membership is imported; mixed order and empty groups remain current.
    const nextGroup = targetGroup ?? {
      ...group!,
      id: targetGroupId,
      tabOrder: [],
      activeTabId: null,
      recentTabIds: []
    }
    const tabOrder = [...nextGroup.tabOrder]
    if (!tabOrder.includes(unifiedId)) {
      const incomingOrder = (group?.tabOrder ?? []).map(
        (id) =>
          unified.find((row) => row.contentType === 'terminal' && row.entityId === id)?.id ?? id
      )
      const position = incomingOrder.indexOf(unifiedId)
      const preceding = incomingOrder
        .slice(0, position)
        .toReversed()
        .find((id) => tabOrder.includes(id))
      const following = incomingOrder.slice(position + 1).find((id) => tabOrder.includes(id))
      if (preceding && following && tabOrder.indexOf(preceding) >= tabOrder.indexOf(following)) {
        return unresolved()
      }
      const at = preceding
        ? tabOrder.indexOf(preceding) + 1
        : following
          ? tabOrder.indexOf(following)
          : tabOrder.length
      tabOrder.splice(at, 0, unifiedId)
    }
    disposition = 'installed'
    return {
      terminalPaneStartsByPaneKey: heldFacts,
      terminalLayoutsByTabId: replaceRecordEntries(state.terminalLayoutsByTabId, [
        [tab.id, nextLayout]
      ]),
      ...(currentTab
        ? {}
        : {
            tabsByWorktree: replaceTabBuckets(state.tabsByWorktree, [[worktreeId, [...tabs, tab]]]),
            ptyIdsByTabId: replaceRecordEntries<string[]>(state.ptyIdsByTabId, [[tab.id, []]])
          }),
      ...(existingUnified
        ? {}
        : {
            unifiedTabsByWorktree: replaceTabBuckets(state.unifiedTabsByWorktree, [
              [
                worktreeId,
                [
                  ...unified,
                  {
                    id: tab.id,
                    entityId: tab.id,
                    groupId: targetGroupId,
                    worktreeId,
                    contentType: 'terminal' as const,
                    executionHostId: start.executionHostId,
                    label: tab.title,
                    customLabel: tab.customTitle,
                    color: tab.color,
                    sortOrder: tabOrder.indexOf(unifiedId),
                    createdAt: tab.createdAt,
                    ...(tab.viewMode ? { viewMode: tab.viewMode } : {})
                  }
                ]
              ]
            ])
          }),
      groupsByWorktree: replaceRecordEntries(state.groupsByWorktree, [
        [
          worktreeId,
          targetGroup
            ? groups.map((row) => (row.id === targetGroupId ? { ...row, tabOrder } : row))
            : [...groups, { ...nextGroup, tabOrder, activeTabId: unifiedId }]
        ]
      ]),
      layoutByWorktree: replaceRecordEntries(state.layoutByWorktree, [
        [worktreeId, nextGroupLayout]
      ])
    }
  })
  return disposition
}
