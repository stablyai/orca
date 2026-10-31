import { moveNativeChatComposerDestinations } from './native-chat-composer-destination'
import type { NativeChatComposerDraftOwner } from './native-chat-composer-draft-storage'
import {
  launchDraftSources,
  relocateLaunchDraftSource,
  type LaunchDraftSource
} from './native-chat-launch-draft-source'
import {
  records,
  load,
  scopeListeners,
  appendListeners,
  submissions,
  restoredImageChecks,
  restoredImageKey,
  notifyScope,
  notifyDraftAppend
} from './native-chat-composer-draft-memory'
import { withNativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import {
  appendToNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { moveNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'

/** One accepted application rebinds references directly and transfers through ordinary persistence. */
export function transitionLaunchDrafts(
  destination: (source: LaunchDraftSource) => NativeChatComposerDraftOwner | undefined
): void {
  const moves = new Map<string, string>()
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
    moves.set(from, to)
    const checks = restoredImageChecks.get(from)
    const draft = records.get(from)
    if (!load.hydrated) {
      load.handoffsBeforeLoad.set(from, { to, owner, hasCurrent: !!draft })
    }
    if (draft) {
      const current = records.get(to) ?? { text: '', images: [], savedAt: 0 }
      notifyDraftAppend(
        from,
        (composed) => ({
          ...current,
          ...withNativeChatComposerDraftAddition(current, {
            ...composed,
            images: composed.images.filter(
              (image) => !current.images.some((held) => held.id === image.id)
            )
          })
        }),
        draft
      )
      appendToNativeChatComposerDraft(
        to,
        {
          ...draft,
          images: draft.images.filter(
            (image) => !current?.images.some((held) => held.id === image.id)
          )
        },
        owner
      )
    }
    updateNativeChatComposerDraft(from, { text: '', document: undefined, images: [] }, 'immediate')
    moveNativeChatComposerDestinations(from, to)
    mergeMembers(scopeListeners, from, to)
    mergeMembers(appendListeners, from, to)
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
    moveNativeChatPendingAttachments(from, to)
    notifyScope(to)
  }
  for (const held of load.handoffsBeforeLoad.values()) {
    held.to = moves.get(held.to) ?? held.to
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
