import { presentationRecordDraft, finishPresentationRecord } from './presentation-record-drafts'
import { terminalLayoutEqual } from '../../../../../shared/workspace-layout/terminal-topology/terminal-layout-equality'
import { removeTabsAttention } from '../../../store/slices/workspace-attention/subject-attention-transitions'
import { hostSnapshotAffirmsWorktreeContents } from '../hydration/host-session-snapshot-authority'
import { isWebSessionTabsWorktreeRemovalFrame } from '../tracking/session-tabs-inventory-absence'
import type { prepareWebSessionTabsSnapshotGroups } from './apply-preparation-groups'
import { sameStringArray, writableWebSessionTabsRecord } from './state-equality-core'

type TerminalRecordContext = ReturnType<typeof prepareWebSessionTabsSnapshotGroups>

export function applyTerminalRecordUpdates(context: TerminalRecordContext) {
  const {
    state,
    snapshot,
    nextTerminalTabs,
    batchContext,
    mirroredTerminalTabs,
    removedTerminalResourceIds,
    exactProvisionalHandoffs
  } = context

  const ptyDraft = presentationRecordDraft(state, 'ptyIdsByTabId', batchContext)
  for (const removedId of removedTerminalResourceIds) {
    ptyDraft.delete(removedId)
  }
  for (const { tab, ptyIds } of mirroredTerminalTabs) {
    if (ptyIds.length === 0) {
      ptyDraft.delete(tab.id)
    } else if (!sameStringArray(ptyDraft.get(tab.id) ?? [], ptyIds)) {
      ptyDraft.set(tab.id, ptyIds)
    }
  }
  const nextPtyIdsByTabId = finishPresentationRecord(state, 'ptyIdsByTabId', ptyDraft, batchContext)

  const layoutDraft = presentationRecordDraft(state, 'terminalLayoutsByTabId', batchContext)
  for (const removedId of removedTerminalResourceIds) {
    layoutDraft.delete(removedId)
  }
  for (const { tab, layout } of mirroredTerminalTabs) {
    if (!terminalLayoutEqual(layoutDraft.get(tab.id), layout)) {
      layoutDraft.set(tab.id, layout)
    }
  }
  const nextTerminalLayoutsByTabId = finishPresentationRecord(
    state,
    'terminalLayoutsByTabId',
    layoutDraft,
    batchContext
  )

  // Local-only home retires with tabs but host frames never rewrite live entries; keeping it outside layout preserves this ownership.
  let nextLocalOnlyScrollbackByTabId = state.localOnlyScrollbackByTabId
  for (const removedId of removedTerminalResourceIds) {
    if (!nextLocalOnlyScrollbackByTabId?.[removedId]) {
      continue
    }
    nextLocalOnlyScrollbackByTabId =
      nextLocalOnlyScrollbackByTabId === state.localOnlyScrollbackByTabId
        ? writableWebSessionTabsRecord(state, 'localOnlyScrollbackByTabId', batchContext)
        : nextLocalOnlyScrollbackByTabId
    delete nextLocalOnlyScrollbackByTabId[removedId]
  }

  // An unpublished or removal frame can drop the tab bucket without proving the worker closed.
  const dropsAttention =
    nextTerminalTabs !== null &&
    hostSnapshotAffirmsWorktreeContents(snapshot) &&
    !isWebSessionTabsWorktreeRemovalFrame(snapshot)
  const attention = dropsAttention
    ? removeTabsAttention(
        {
          unreadTerminalTabs: state.unreadTerminalTabs,
          unreadTerminalPanes: state.unreadTerminalPanes ?? {},
          unreadAgentCompletionPanes: state.unreadAgentCompletionPanes ?? {}
        },
        removedTerminalResourceIds
      )
    : null
  const nextUnreadTerminalTabs = attention?.unreadTerminalTabs ?? state.unreadTerminalTabs
  const nextUnreadTerminalPanes = attention?.unreadTerminalPanes ?? state.unreadTerminalPanes
  const nextUnreadAgentCompletionPanes =
    attention?.unreadAgentCompletionPanes ?? state.unreadAgentCompletionPanes

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
    nextLocalOnlyScrollbackByTabId,
    nextUnreadTerminalTabs,
    nextUnreadTerminalPanes,
    nextUnreadAgentCompletionPanes,
    pendingStartupByTabId,
    nextPendingStartupByTabId,
    automaticAgentResumeClaimsByTabId,
    nextAutomaticAgentResumeClaimsByTabId
  }
}
