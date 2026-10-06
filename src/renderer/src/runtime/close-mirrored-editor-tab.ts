import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { recordWebSessionCloseIntent } from './web-session-close-intent'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import type { OpenFile } from '@/store/slices/editor'
import type { Tab } from '../../../shared/tab-types'
import { hostSessionTabPublishersForLocalTab } from './web-session-tabs-sync/tracking-mappings'

export type MirroredEditorCloseState = WorktreeRuntimeOwnerState & {
  openFiles: readonly OpenFile[]
  unifiedTabsByWorktree: Record<string, Tab[]>
}

// Closing the publisher counterpart prevents its next snapshot from reopening the local tab.
export function notifyHostOfMirroredEditorClose(
  state: MirroredEditorCloseState,
  worktreeId: string | null | undefined,
  fileId: string
): boolean {
  if (!worktreeId) {
    return false
  }
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  if (!file || file.worktreeId !== worktreeId) {
    return false
  }
  // Local tab ids can differ from the publisher ids retained in the ledger.
  const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.contentType === 'editor' && tab.entityId === fileId
  )
  if (!unifiedTab) {
    return false
  }
  const publishers = hostSessionTabPublishersForLocalTab(worktreeId, unifiedTab.id)
  const legacyOwner = file.mirroredFromRuntimeSession
    ? getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    : null
  if (publishers.length === 0 && legacyOwner?.trim()) {
    publishers.push({ environmentId: legacyOwner, hostTabId: unifiedTab.id })
  }
  if (publishers.length === 0) {
    return false
  }
  // Suppress echoes before the lazy RPC import settles.
  for (const publisher of publishers) {
    recordWebSessionCloseIntent(
      { environmentId: publisher.environmentId },
      worktreeId,
      toHostSessionTabId(publisher.hostTabId),
      Date.now()
    )
  }
  // Eager RPC imports would cycle back into the store during editor-slice initialization.
  void import('./web-runtime-session').then(({ closeWebRuntimeSessionTab }) => {
    for (const publisher of publishers) {
      void closeWebRuntimeSessionTab({
        worktreeId,
        tabId: publisher.hostTabId,
        environmentId: publisher.environmentId,
        reason: 'user'
      })
    }
  })
  return true
}
