import {
  load,
  releaseNativeChatComposerSubmission,
  resolveNativeChatComposerDraftOwner,
  type DraftSubmission,
  records,
  dirtyScopes,
  unconfirmed,
  refusedScopes,
  installNativeChatDraftRecord,
  nextSavedAt,
  transferSources,
  transferDestinations
} from './native-chat-composer-draft-memory'
import { appendToNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { nativeChatLaunchPromptDraftOwner } from './native-chat-launch-draft-source'
import type {
  NativeChatComposerDraftOwner,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import { persistNativeChatComposerDraft } from './native-chat-composer-draft-persistence'

export type DraftTransfer = {
  readonly from: string
  readonly destination: { scopeKey: string }
  readonly select: (
    stored: StoredNativeChatComposerDraft | null | undefined
  ) => StoredNativeChatComposerDraft | undefined
  readonly deletionCount: number
  readonly deletionContexts: {
    scope: string
    owner?: NativeChatComposerDraftOwner
    start: number
    end: number
  }[]
  currentDeletionStart: number
  sourceWritable: boolean
  pending: boolean
  readyAt: number
}

function release(transfer: DraftTransfer): void {
  for (const [family, key] of [
    [transferSources, transfer.from],
    [transferDestinations, transfer.destination.scopeKey]
  ] as const) {
    const members = family.get(key)
    members?.delete(transfer)
    if (!members?.size) {
      family.delete(key)
    }
  }
}

/** Capture ordinary source authority before the adapter clears its visible address. */
export function beginNativeChatDraftTransfer(
  from: string,
  destination: { scopeKey: string }
): DraftTransfer {
  const current = records.get(from)
  const replacement = load.hydrated || load.editedBeforeLoad.has(from)
  const appends = load.appendsBeforeLoad.get(from) ?? []
  const transfer: DraftTransfer = {
    from,
    destination,
    deletionCount: load.deletionsBeforeLoad.length,
    deletionContexts: [],
    currentDeletionStart: load.deletionsBeforeLoad.length,
    sourceWritable: true,
    pending: !load.hydrated,
    readyAt: Infinity,
    select: (stored) => {
      if (replacement) {
        return undefined
      }
      // The visible additions have already moved. Select their actual stored base, not a second copy.
      const first = appends.find(
        (entry) => entry.before && (entry.appliedAt ?? Infinity) <= (stored?.savedAt ?? 0)
      )
      return first?.before ?? stored ?? undefined
    }
  }
  const source = transferSources.get(from) ?? new Set<DraftTransfer>()
  source.add(transfer)
  transferSources.set(from, source)
  const target = transferDestinations.get(destination.scopeKey) ?? new Set<DraftTransfer>()
  target.add(transfer)
  transferDestinations.set(destination.scopeKey, target)
  const before = records.get(destination.scopeKey)
  if (current) {
    appendToNativeChatComposerDraft(
      destination.scopeKey,
      current,
      nativeChatLaunchPromptDraftOwner(destination.scopeKey),
      true
    )
  }
  installNativeChatDraftRecord(from)
  dirtyScopes.delete(from)
  unconfirmed.delete(from)
  refusedScopes.delete(from)
  if (!load.hydrated) {
    load.appendsBeforeLoad.delete(from)
    load.editedBeforeLoad.add(from)
  } else {
    transfer.pending = false
    transfer.readyAt = records.get(destination.scopeKey)?.savedAt ?? nextSavedAt()
    // An unchanged full result still needs an actual confirmation, not an empty pending-set success.
    if (!current) {
      retire(transfer)
    } else if (records.get(destination.scopeKey) === before) {
      dirtyScopes.add(destination.scopeKey)
    }
  }
  return transfer
}

/** Called after ordinary loaded records have been admitted; current edits and empty values already won. */
export function completeNativeChatDraftTransfers(
  drafts: Map<string, StoredNativeChatComposerDraft | null>
): void {
  for (const [from, transfers] of transferSources) {
    for (const transfer of transfers) {
      if (!transfer.pending) {
        continue
      }
      const stored = drafts.get(from)
      const source = transfer.select(stored)
      const removed =
        source &&
        (load.deletionsBeforeLoad
          .slice(0, transfer.deletionCount)
          .some((matches) => matches(from, source)) ||
          [
            ...transfer.deletionContexts,
            {
              scope: transfer.destination.scopeKey,
              owner: nativeChatLaunchPromptDraftOwner(transfer.destination.scopeKey),
              start: transfer.currentDeletionStart,
              end: load.deletionsBeforeLoad.length
            }
          ].some((context) =>
            load.deletionsBeforeLoad
              .slice(context.start, context.end)
              .some((matches) => matches(context.scope, { ...source, owner: context.owner }))
          ))
      transfer.pending = false
      if (source && !removed) {
        appendToNativeChatComposerDraft(
          transfer.destination.scopeKey,
          source,
          nativeChatLaunchPromptDraftOwner(transfer.destination.scopeKey),
          true
        )
      }
      transfer.readyAt = records.get(transfer.destination.scopeKey)?.savedAt ?? nextSavedAt()
      dirtyScopes.add(transfer.destination.scopeKey)
    }
  }
}

/** Ordinary live deletion already selected this key; cancel only its directly indexed operations. */
export function deleteNativeChatDraftTransfersAt(key: string): void {
  for (const transfer of transferDestinations.get(key) ?? []) {
    retire(transfer)
  }
}

/** Keep only deletion intervals for a moved contribution; lookup itself remains a direct destination. */
export function moveNativeChatDraftTransferContext(from: string): void {
  for (const transfer of transferDestinations.get(from) ?? []) {
    transfer.deletionContexts.push({
      scope: from,
      owner: nativeChatLaunchPromptDraftOwner(from),
      start: transfer.currentDeletionStart,
      end: load.deletionsBeforeLoad.length
    })
    transfer.currentDeletionStart = load.deletionsBeforeLoad.length
  }
}

/** Only an actual complete destination commit can retire its still-owned source copy. */
export function confirmNativeChatDraftTransfers(key: string, at: number): void {
  for (const transfer of transferDestinations.get(key) ?? []) {
    if (transfer.pending || at < transfer.readyAt) {
      continue
    }
    if (transfer.sourceWritable && !records.has(transfer.from)) {
      retire(transfer)
    } else {
      release(transfer)
    }
  }
}

function retire(transfer: DraftTransfer): void {
  release(transfer)
  if (transfer.sourceWritable && !records.has(transfer.from)) {
    persistNativeChatComposerDraft(transfer.from, 'immediate')
  }
}

/** Exhausted ordinary reads leave unknown saved sources intact; known live input remains in records. */
export function abandonNativeChatDraftTransfers(): void {
  for (const transfers of transferSources.values()) {
    for (const transfer of transfers) {
      if (transfer.pending) {
        release(transfer)
      }
    }
  }
}

export function finishNativeChatComposerSubmission(
  scopeKey: string,
  submission: DraftSubmission,
  recover = false
): void {
  scopeKey = submission.scopeKey
  const draft = releaseNativeChatComposerSubmission(scopeKey, submission)
  if (recover && draft) {
    appendToNativeChatComposerDraft(
      scopeKey,
      draft,
      resolveNativeChatComposerDraftOwner(scopeKey) ?? draft.owner,
      true
    )
  }
}
