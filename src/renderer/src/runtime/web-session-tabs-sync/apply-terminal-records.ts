import { terminalLayoutEqual } from '@/lib/terminal-layout-equality'
import type { prepareWebSessionTabsSnapshotGroups } from './apply-preparation-groups'
import { sameStringArray, writableWebSessionTabsRecord } from './state-equality-core'

type TerminalRecordContext = ReturnType<typeof prepareWebSessionTabsSnapshotGroups>

/** Reconcile PTY ownership, layouts, unread markers, and provisional startup records. */
export function applyTerminalRecordUpdates(context: TerminalRecordContext) {
  const {
    state,
    batchContext,
    mirroredTerminalTabs,
    removedTerminalResourceIds,
    removedTerminalIds,
    exactProvisionalHandoffs
  } = context

  let nextPtyIdsByTabId = state.ptyIdsByTabId
  for (const removedId of removedTerminalResourceIds) {
    if (!nextPtyIdsByTabId[removedId]) {
      continue
    }
    nextPtyIdsByTabId =
      nextPtyIdsByTabId === state.ptyIdsByTabId
        ? writableWebSessionTabsRecord(state, 'ptyIdsByTabId', batchContext)
        : nextPtyIdsByTabId
    delete nextPtyIdsByTabId[removedId]
  }
  for (const { tab, ptyIds } of mirroredTerminalTabs) {
    if (ptyIds.length === 0) {
      if (nextPtyIdsByTabId[tab.id]) {
        nextPtyIdsByTabId =
          nextPtyIdsByTabId === state.ptyIdsByTabId
            ? writableWebSessionTabsRecord(state, 'ptyIdsByTabId', batchContext)
            : nextPtyIdsByTabId
        delete nextPtyIdsByTabId[tab.id]
      }
      continue
    }
    const current = nextPtyIdsByTabId[tab.id] ?? []
    if (sameStringArray(current, ptyIds)) {
      continue
    }
    nextPtyIdsByTabId =
      nextPtyIdsByTabId === state.ptyIdsByTabId
        ? writableWebSessionTabsRecord(state, 'ptyIdsByTabId', batchContext)
        : nextPtyIdsByTabId
    nextPtyIdsByTabId[tab.id] = ptyIds
  }

  let nextTerminalLayoutsByTabId = state.terminalLayoutsByTabId
  for (const removedId of removedTerminalResourceIds) {
    if (!nextTerminalLayoutsByTabId[removedId]) {
      continue
    }
    nextTerminalLayoutsByTabId =
      nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
        ? writableWebSessionTabsRecord(state, 'terminalLayoutsByTabId', batchContext)
        : nextTerminalLayoutsByTabId
    delete nextTerminalLayoutsByTabId[removedId]
  }
  for (const { tab, layout } of mirroredTerminalTabs) {
    if (terminalLayoutEqual(nextTerminalLayoutsByTabId[tab.id], layout)) {
      continue
    }
    nextTerminalLayoutsByTabId =
      nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
        ? writableWebSessionTabsRecord(state, 'terminalLayoutsByTabId', batchContext)
        : nextTerminalLayoutsByTabId
    nextTerminalLayoutsByTabId[tab.id] = layout
  }

  let nextUnreadTerminalTabs = state.unreadTerminalTabs
  for (const removedId of removedTerminalIds) {
    if (!nextUnreadTerminalTabs[removedId]) {
      continue
    }
    nextUnreadTerminalTabs =
      nextUnreadTerminalTabs === state.unreadTerminalTabs
        ? writableWebSessionTabsRecord(state, 'unreadTerminalTabs', batchContext)
        : nextUnreadTerminalTabs
    delete nextUnreadTerminalTabs[removedId]
  }

  const pendingStartupByTabId = state.pendingStartupByTabId ?? {}
  let nextPendingStartupByTabId = pendingStartupByTabId
  const automaticAgentResumeClaimsByTabId = state.automaticAgentResumeClaimsByTabId ?? {}
  let nextAutomaticAgentResumeClaimsByTabId = automaticAgentResumeClaimsByTabId
  for (const removedId of exactProvisionalHandoffs) {
    if (nextPendingStartupByTabId[removedId]) {
      nextPendingStartupByTabId =
        nextPendingStartupByTabId === pendingStartupByTabId
          ? writableWebSessionTabsRecord(state, 'pendingStartupByTabId', batchContext)
          : nextPendingStartupByTabId
      delete nextPendingStartupByTabId[removedId]
    }
    if (nextAutomaticAgentResumeClaimsByTabId[removedId]) {
      nextAutomaticAgentResumeClaimsByTabId =
        nextAutomaticAgentResumeClaimsByTabId === automaticAgentResumeClaimsByTabId
          ? writableWebSessionTabsRecord(state, 'automaticAgentResumeClaimsByTabId', batchContext)
          : nextAutomaticAgentResumeClaimsByTabId
      delete nextAutomaticAgentResumeClaimsByTabId[removedId]
    }
  }

  return {
    ...context,
    nextPtyIdsByTabId,
    nextTerminalLayoutsByTabId,
    nextUnreadTerminalTabs,
    pendingStartupByTabId,
    nextPendingStartupByTabId,
    automaticAgentResumeClaimsByTabId,
    nextAutomaticAgentResumeClaimsByTabId
  }
}
