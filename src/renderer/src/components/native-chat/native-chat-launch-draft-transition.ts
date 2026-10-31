import {
  placeNativeChatComposerDraftAddition,
  withIndependentNativeChatComposerDraft
} from './native-chat-composer-draft-addition'
import { moveNativeChatComposerDestinations } from './native-chat-composer-destination'
import type { NativeChatComposerDraftOwner } from './native-chat-composer-draft-storage'
import {
  launchDraftSources,
  relocateLaunchDraftSource,
  type LaunchDraftSource
} from './native-chat-launch-draft-source'
import {
  installNativeChatDraftRecord,
  nextSavedAt,
  reconcileRestoredImageChecks,
  records,
  scopeListeners,
  appendListeners,
  submissions,
  restoredImageChecks,
  restoredImageKey,
  notifyScope
} from './native-chat-composer-draft-memory'
import {
  moveNativeChatPendingAttachments,
  moveLaunchPendingAttachmentListeners
} from './native-chat-pending-attachment-cache'
/** One accepted application rebinds references directly and joins complete current memory. */
export function transitionLaunchDrafts(
  destination: (source: LaunchDraftSource) => NativeChatComposerDraftOwner | undefined
): void {
  const sources = Array.from(launchDraftSources())
  for (const source of sources) {
    const owner = destination(source)
    if (
      !owner ||
      (owner.workspaceId === source.workspaceId && owner.executionHostId === source.executionHostId)
    ) {
      continue
    }
    const from = source.scopeKey
    const target = relocateLaunchDraftSource(source, owner)
    const to = target.scopeKey
    const checks = restoredImageChecks.get(from)
    const draft = records.get(from)
    const before = records.get(to) ?? { text: '', images: [], savedAt: 0, owner: undefined }
    const sourceAppends = appendListeners.get(from)
    const targetAppends = Array.from(appendListeners.get(to) ?? [])
    const placed = draft && placeNativeChatComposerDraftAddition(before, draft)
    moveNativeChatComposerDestinations(from, to)
    mergeMembers(scopeListeners, from, to)
    mergeMembers(appendListeners, from, to)
    moveLaunchPendingAttachmentListeners(from, to)
    for (const submission of submissions.get(from) ?? []) {
      submission.scopeKey = to
    }
    mergeMembers(submissions, from, to)
    if (checks) {
      const keys = new Set(checks.map((check) => restoredImageKey(check.image)))
      restoredImageChecks.set(to, [
        ...(restoredImageChecks.get(to) ?? []).filter(
          (check) => !keys.has(restoredImageKey(check.image))
        ),
        ...checks
      ])
      restoredImageChecks.delete(from)
    }
    installNativeChatDraftRecord(from)
    if (placed) {
      const merged = withIndependentNativeChatComposerDraft(before, placed)
      installNativeChatDraftRecord(to, {
        ...before,
        ...merged,
        owner: before.owner ?? owner,
        savedAt: nextSavedAt()
      })
      reconcileRestoredImageChecks(to, merged.images)
    }
    moveNativeChatPendingAttachments(from, to)
    if (placed && records.get(to)?.text !== before.text) {
      targetAppends.forEach((listener) => listener(placed, before))
    }
    if (draft) {
      sourceAppends?.forEach((listener) =>
        listener(
          (composed) => ({
            ...before,
            ...withIndependentNativeChatComposerDraft(before, composed)
          }),
          draft
        )
      )
    }
    notifyScope(to)
  }
}
function mergeMembers<T>(family: Map<string, Set<T>>, from: string, to: string): void {
  const held = family.get(from)
  if (!held) {
    return
  }
  const target = family.get(to) ?? new Set<T>()
  for (const member of held) {
    target.add(member)
  }
  family.set(to, target)
  family.delete(from)
}
