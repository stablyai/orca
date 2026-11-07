import { collectNativeChatStagedRemovals } from './native-chat-staged-removal'
import { dropCapturedNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import type { NativeChatDraftReturnEvent } from './native-chat-draft-return-products'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'
import {
  records,
  submissions,
  dirtyScopes,
  unconfirmed,
  deferredRemovals,
  installNativeChatDraftRecord,
  notifyScope,
  reconcileRestoredImageChecks,
  releaseNativeChatComposerSubmission
} from './native-chat-composer-draft-memory'
import {
  supersedeNativeChatComposerDraftRead,
  trackNativeChatComposerDraftRemoval
} from './native-chat-composer-draft-persistence'
import {
  nativeChatComposerDraftStorage,
  KEEP_NATIVE_CHAT_DRAFT,
  parseStoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import { selectNativeChatDraftRemovalProducts } from './native-chat-composer-draft-removal-products'
import type { NativeChatStagedRemoval } from './native-chat-draft-attachment-staging'
import {
  nativeChatDraftValueKey,
  type NativeChatDraftRemovalScope
} from './native-chat-composer-draft-removal-capture'
export {
  captureNativeChatDraftRemovalScopes,
  nativeChatDraftRemovalHosts,
  observeNativeChatDraftRemovalReturns,
  type NativeChatDraftRemovalScope
} from './native-chat-composer-draft-removal-capture'

/** Consume frozen handles now; storage later executes this same value selection. */
export function consumeNativeChatDraftRemovalScope(
  captured: NativeChatDraftRemovalScope,
  exclusions: { values: Map<string, ReadonlySet<string>>; journal: Set<string> },
  submissionsOnly: boolean,
  selection: ReturnType<typeof selectNativeChatDraftRemovalProducts>,
  staged?: NativeChatStagedRemoval
): boolean {
  const { scope, edit } = captured
  if (!selection.accepted.has(scope)) {
    return false
  }
  for (const { submission, destination } of captured.submissions) {
    if (submission.scopeKey === destination && submissions.get(destination)?.has(submission)) {
      releaseNativeChatComposerSubmission(destination, submission)
    }
  }
  if (submissionsOnly) {
    return true
  }
  const current = records.get(scope)
  if (edit?.returning && current && selection.eligible(scope, current)) {
    edit.returning.revoked = current
  }
  for (const [id, operation] of captured.pastes) {
    if (
      nativeChatPastedTextOperations.get(id) === operation &&
      operation.scopeKey === selection.holders.get(operation)
    ) {
      nativeChatPastedTextOperations.delete(id)
    }
  }
  const retire = (operation: NativeChatDraftRemovalScope['operations'][number]) => {
    operation.retired = true
    const applied = operation.applied
    if (
      applied &&
      ('draft' in operation || captured.expected.has(nativeChatDraftValueKey(applied.input)))
    ) {
      captured.expected.add(nativeChatDraftValueKey(applied.output))
      const parsed = parseStoredNativeChatComposerDraft(applied.output)
      if (parsed) {
        captured.loaded.add(nativeChatDraftValueKey(parsed))
      }
    }
    if (unconfirmed.get(scope) === operation) {
      unconfirmed.delete(scope)
    }
  }
  for (const operation of selection.operations.get(scope) ?? []) {
    retire(operation)
  }
  supersedeNativeChatComposerDraftRead(scope, captured.foreignRead)
  const selected = selection.selected.get(scope) ?? false
  if (selected) {
    dirtyScopes.delete(scope)
    if (!edit) {
      installNativeChatDraftRecord(scope, undefined, undefined, staged)
      reconcileRestoredImageChecks(scope, [])
      notifyScope(scope)
    }
  }
  for (const [source, transfer] of captured.transfers) {
    if (deferredRemovals.get(source) === transfer && !records.has(source)) {
      deferredRemovals.delete(source)
      dirtyScopes.delete(source)
    }
  }
  exclusions.values.set(scope, captured.loaded)
  for (const entry of captured.journal) {
    exclusions.journal.add(entry)
  }
  return true
}

export function persistNativeChatDraftRemovalScope(captured: NativeChatDraftRemovalScope) {
  if (captured.edit) {
    return Promise.resolve({ ok: true, removed: false })
  }
  let removed = false
  const written = nativeChatComposerDraftStorage()
    .update(captured.scope, (stored) => {
      if (!captured.expected.has(nativeChatDraftValueKey(stored))) {
        return KEEP_NATIVE_CHAT_DRAFT
      }
      removed = true
      return null
    })
    .then(
      () => ({ ok: true, removed }),
      () => ({ ok: false, removed: false })
    )
  trackNativeChatComposerDraftRemoval(
    captured.scope,
    written.then((result) => result.ok)
  )
  return written
}

export function consumeNativeChatDraftRemovalCandidate(
  scopes: readonly NativeChatDraftRemovalScope[],
  stream:
    | { events: readonly NativeChatDraftReturnEvent[]; sources: ReadonlyMap<object, string> }
    | undefined,
  exclusions: { values: Map<string, ReadonlySet<string>>; journal: Set<string> },
  submissionsOnly: boolean
) {
  const selection = selectNativeChatDraftRemovalProducts(
    scopes,
    stream?.events ?? [],
    stream?.sources ?? new Map()
  )
  const staged = submissionsOnly
    ? undefined
    : collectNativeChatStagedRemovals(
        scopes
          .filter((captured) => selection.accepted.has(captured.scope))
          .map((captured) => ({
            captured: captured.staged,
            selected: selection.selected.get(captured.scope) ?? false
          })),
        selection.holders.keys()
      )
  if (!submissionsOnly) {
    const chips = new Map<string, object[]>()
    for (const captured of scopes) {
      for (const chip of captured.pending?.chips ?? []) {
        const holder = selection.holders.get(chip)
        if (!holder) {
          continue
        }
        const held = chips.get(holder) ?? []
        held.push(chip)
        chips.set(holder, held)
      }
    }
    for (const [scope, held] of chips) {
      dropCapturedNativeChatPendingAttachments(scope, held)
    }
  }
  const selected: NativeChatDraftRemovalScope[] = []
  try {
    for (const captured of scopes) {
      if (
        consumeNativeChatDraftRemovalScope(
          captured,
          exclusions,
          submissionsOnly,
          selection,
          staged?.byScope.get(captured.scope)
        ) &&
        !submissionsOnly
      ) {
        selected.push(captured)
      }
    }
  } finally {
    staged?.finish()
  }
  return selected
}
