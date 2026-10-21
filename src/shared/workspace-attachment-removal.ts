import type { WorkspaceAttachment } from './worktree/types'
import {
  getWorkspaceAttachmentKey,
  matchesWorkspaceAttachmentIdentity
} from './workspace-attachment-normalization'

export function removeSelectedWorkspaceAttachments(
  items: WorkspaceAttachment[],
  legacyItems: WorkspaceAttachment[],
  selectedTask?: WorkspaceAttachment
): WorkspaceAttachment[] {
  const removedKeys = new Set<string>()
  for (const legacy of legacyItems) {
    const candidates = items.filter((item) => matchesWorkspaceAttachmentIdentity(item, legacy))
    const selected =
      selectedTask &&
      candidates.find((item) => matchesWorkspaceAttachmentIdentity(item, selectedTask))
    // An unscoped compatibility slot cannot choose between same-number sources.
    const removed = selected ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (removed) {
      removedKeys.add(getWorkspaceAttachmentKey(removed))
    }
  }
  return items.filter((item) => !removedKeys.has(getWorkspaceAttachmentKey(item)))
}
