import { terminalLayoutEqual } from '../../../../shared/terminal-layout-equality'
import type { prepareWebSessionTabsSnapshotGroups } from './apply-preparation-groups'
import { sameStringArray, setWebSessionTabsRecordEntry } from './state-equality-core'

type TerminalRecordContext = ReturnType<typeof prepareWebSessionTabsSnapshotGroups>

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
    nextPtyIdsByTabId = setWebSessionTabsRecordEntry(
      state,
      'ptyIdsByTabId',
      removedId,
      undefined,
      batchContext,
      true,
      nextPtyIdsByTabId
    )
  }
  for (const { tab, ptyIds } of mirroredTerminalTabs) {
    if (ptyIds.length === 0) {
      if (nextPtyIdsByTabId[tab.id]) {
        nextPtyIdsByTabId = setWebSessionTabsRecordEntry(
          state,
          'ptyIdsByTabId',
          tab.id,
          undefined,
          batchContext,
          true,
          nextPtyIdsByTabId
        )
      }
      continue
    }
    const current = nextPtyIdsByTabId[tab.id] ?? []
    if (sameStringArray(current, ptyIds)) {
      continue
    }
    nextPtyIdsByTabId = setWebSessionTabsRecordEntry(
      state,
      'ptyIdsByTabId',
      tab.id,
      ptyIds,
      batchContext,
      false,
      nextPtyIdsByTabId
    )
  }

  let nextTerminalLayoutsByTabId = state.terminalLayoutsByTabId
  for (const removedId of removedTerminalResourceIds) {
    if (!nextTerminalLayoutsByTabId[removedId]) {
      continue
    }
    nextTerminalLayoutsByTabId = setWebSessionTabsRecordEntry(
      state,
      'terminalLayoutsByTabId',
      removedId,
      undefined,
      batchContext,
      true,
      nextTerminalLayoutsByTabId
    )
  }
  for (const { tab, layout } of mirroredTerminalTabs) {
    if (terminalLayoutEqual(nextTerminalLayoutsByTabId[tab.id], layout)) {
      continue
    }
    nextTerminalLayoutsByTabId = setWebSessionTabsRecordEntry(
      state,
      'terminalLayoutsByTabId',
      tab.id,
      layout,
      batchContext,
      false,
      nextTerminalLayoutsByTabId
    )
  }

  // Local-only home retires with tabs but host frames never rewrite live entries; keeping it outside layout preserves this ownership.
  let nextLocalOnlyScrollbackByTabId = state.localOnlyScrollbackByTabId
  for (const removedId of removedTerminalResourceIds) {
    if (!nextLocalOnlyScrollbackByTabId?.[removedId]) {
      continue
    }
    nextLocalOnlyScrollbackByTabId = setWebSessionTabsRecordEntry(
      state,
      'localOnlyScrollbackByTabId',
      removedId,
      undefined,
      batchContext,
      true,
      nextLocalOnlyScrollbackByTabId
    )
  }

  let nextUnreadTerminalTabs = state.unreadTerminalTabs
  for (const removedId of removedTerminalIds) {
    if (!nextUnreadTerminalTabs[removedId]) {
      continue
    }
    nextUnreadTerminalTabs = setWebSessionTabsRecordEntry(
      state,
      'unreadTerminalTabs',
      removedId,
      undefined,
      batchContext,
      true,
      nextUnreadTerminalTabs
    )
  }

  const pendingStartupByTabId = state.pendingStartupByTabId ?? {}
  let nextPendingStartupByTabId = pendingStartupByTabId
  const automaticAgentResumeClaimsByTabId = state.automaticAgentResumeClaimsByTabId ?? {}
  let nextAutomaticAgentResumeClaimsByTabId = automaticAgentResumeClaimsByTabId
  for (const removedId of exactProvisionalHandoffs) {
    if (nextPendingStartupByTabId[removedId]) {
      nextPendingStartupByTabId = setWebSessionTabsRecordEntry(
        state,
        'pendingStartupByTabId',
        removedId,
        undefined,
        batchContext,
        true,
        nextPendingStartupByTabId
      )
    }
    if (nextAutomaticAgentResumeClaimsByTabId[removedId]) {
      nextAutomaticAgentResumeClaimsByTabId = setWebSessionTabsRecordEntry(
        state,
        'automaticAgentResumeClaimsByTabId',
        removedId,
        undefined,
        batchContext,
        true,
        nextAutomaticAgentResumeClaimsByTabId
      )
    }
  }

  return {
    ...context,
    nextPtyIdsByTabId,
    nextTerminalLayoutsByTabId,
    nextLocalOnlyScrollbackByTabId,
    nextUnreadTerminalTabs,
    pendingStartupByTabId,
    nextPendingStartupByTabId,
    automaticAgentResumeClaimsByTabId,
    nextAutomaticAgentResumeClaimsByTabId
  }
}
