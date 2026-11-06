// A draft's hand-back receipts and client-source provenance: a projection of the stored record
// plus this renderer's operations on it that no committed write has carried yet.

import { nativeChatTextAttachmentParts } from '../../../../shared/native-chat-text-attachment-references'
import { withIndependentNativeChatComposerDraft } from './native-chat-composer-draft-addition'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftOwner,
  NativeChatDraftHandbackReceipt,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

export type NativeChatDraftHandbackContribution = Pick<
  NativeChatComposerDraft,
  'text' | 'images' | 'document' | 'pastedTextFiles'
>

/** An identified hand-back whose scope's stored base has not been read yet. */
export type PendingNativeChatDraftHandback = {
  readonly receipt: NativeChatDraftHandbackReceipt
  readonly contribution: NativeChatDraftHandbackContribution
  readonly sourcePaths: readonly string[]
}

export type NativeChatDraftCustody = {
  handbacks: NativeChatDraftHandbackReceipt[]
  sourcePaths: string[]
  owner?: NativeChatComposerDraftOwner
  savedAt: number
  /** Backed: a committed record or a written journal entry holds the receipt (witness 1). */
  readonly durable: Set<string>
  /** The scope's base was read, the identity resolved, and a committed record or a written whole
   *  journal snapshot holds the current draft with the receipt (witness 2). */
  readonly incorporated: Set<string>
  /** Incorporated in a committed record, not only the journal. */
  readonly committed: Set<string>
  /** Retirement requested after source death; done once replay can no longer return the input. */
  readonly retiring: Set<string>
  /** Adopted or moved here, not yet in a committed record: every write at the base adds them. */
  readonly added: Set<string>
  /** Retired here, not yet absent from a committed record: no write at the base keeps them. */
  readonly retired: Set<string>
  /** Retirements whose identified addition is discharged, waiting for a committed record
   *  without the receipt; they end with it, or with this custody. */
  readonly discharged: Set<string>
  /** Identified additions this memory holds whose journal entries go once a commit carries it. */
  readonly journaled: Set<string>
  /** Hand-backs waiting for this scope's base; composed onto it by the one reduction below. */
  pending: PendingNativeChatDraftHandback[]
}

export const draftCustody = new Map<string, NativeChatDraftCustody>()
/** Scopes whose memory already holds their complete stored base; a later load must not replace it. */
export const knownDraftBases = new Set<string>()

export function handbackReceiptKey(receipt: NativeChatDraftHandbackReceipt): string {
  return JSON.stringify([receipt.operationId, receipt.clientMessageId, receipt.sessionId ?? null])
}

export function hasHandbackReceipt(
  handbacks: readonly NativeChatDraftHandbackReceipt[] | undefined,
  receipt: NativeChatDraftHandbackReceipt
): boolean {
  const key = handbackReceiptKey(receipt)
  return handbacks?.some((held) => handbackReceiptKey(held) === key) ?? false
}

export function withHandbackReceipts(
  handbacks: readonly NativeChatDraftHandbackReceipt[] | undefined,
  added: readonly NativeChatDraftHandbackReceipt[]
): NativeChatDraftHandbackReceipt[] {
  const next = [...(handbacks ?? [])]
  for (const receipt of added) {
    if (!hasHandbackReceipt(next, receipt)) {
      next.push(receipt)
    }
  }
  return next
}

/** Every path the draft's chips, pasted files and `@path` text still name. */
export function referencedNativeChatDraftPaths(
  draft: NativeChatComposerDraft | undefined
): Set<string> {
  if (!draft) {
    return new Set()
  }
  return new Set([
    ...draft.images.flatMap(({ path }) => (path ? [path] : [])),
    ...Object.values(draft.pastedTextFiles ?? {}),
    ...nativeChatTextAttachmentParts(draft.text, true, () => true).flatMap((part) =>
      part.path ? [part.path] : []
    )
  ])
}

export function scopeCustody(scopeKey: string, savedAt: number): NativeChatDraftCustody {
  let custody = draftCustody.get(scopeKey)
  if (!custody) {
    custody = {
      handbacks: [],
      sourcePaths: [],
      savedAt,
      durable: new Set(),
      incorporated: new Set(),
      committed: new Set(),
      retiring: new Set(),
      added: new Set(),
      retired: new Set(),
      discharged: new Set(),
      journaled: new Set(),
      pending: []
    }
    draftCustody.set(scopeKey, custody)
  }
  return custody
}

function isIdle(custody: NativeChatDraftCustody): boolean {
  return (
    !custody.handbacks.length &&
    !custody.sourcePaths.length &&
    !custody.retired.size &&
    !custody.retiring.size &&
    !custody.discharged.size &&
    !custody.journaled.size &&
    !custody.pending.length
  )
}

export function dropEmptyNativeChatDraftCustody(scopeKey: string): void {
  const custody = draftCustody.get(scopeKey)
  if (custody && isIdle(custody)) {
    draftCustody.delete(scopeKey)
  }
}

/** Provenance lives only as long as the draft still names the path; edits and clears consume it. */
export function pruneNativeChatDraftSourcePaths(
  scopeKey: string,
  draft: NativeChatComposerDraft | undefined
): void {
  const custody = draftCustody.get(scopeKey)
  if (!custody?.sourcePaths.length || custody.pending.length) {
    return
  }
  const referenced = referencedNativeChatDraftPaths(draft)
  custody.sourcePaths = custody.sourcePaths.filter((path) => referenced.has(path))
  dropEmptyNativeChatDraftCustody(scopeKey)
}

/** The draft as memory would save it, with its custody inline. */
export function withNativeChatDraftCustody<T extends StoredNativeChatComposerDraft>(
  record: T | undefined,
  custody: NativeChatDraftCustody | undefined
): T | StoredNativeChatComposerDraft | undefined {
  if (!custody) {
    return record
  }
  const base = record ?? {
    text: '',
    images: [],
    savedAt: custody.savedAt,
    ...(custody.owner ? { owner: custody.owner } : {})
  }
  return {
    ...base,
    savedAt: Math.max(base.savedAt, custody.savedAt),
    ...(custody.handbacks.length ? { handbacks: [...custody.handbacks] } : {}),
    ...(custody.sourcePaths.length ? { sourcePaths: [...custody.sourcePaths] } : {})
  }
}

/** Saved form of content that may carry custody: provenance only for named paths, receipts kept even when empty. */
export function finishStoredNativeChatDraft(
  content: StoredNativeChatComposerDraft | null,
  metadata: Pick<StoredNativeChatComposerDraft, 'handbacks' | 'sourcePaths' | 'owner' | 'savedAt'>
): StoredNativeChatComposerDraft | null {
  const handbacks = metadata.handbacks ?? []
  if (!content) {
    return handbacks.length
      ? {
          text: '',
          images: [],
          savedAt: metadata.savedAt,
          ...(metadata.owner ? { owner: metadata.owner } : {}),
          handbacks
        }
      : null
  }
  const referenced = referencedNativeChatDraftPaths(content)
  const sourcePaths = (metadata.sourcePaths ?? []).filter((path) => referenced.has(path))
  return {
    ...content,
    ...(handbacks.length ? { handbacks } : {}),
    ...(sourcePaths.length ? { sourcePaths } : {})
  }
}

/** The one identified reduction, for live adoption, a scope's base read, load and replay: an
 *  identity the base already holds changes nothing; otherwise the input joins as an independent
 *  contribution. An exactly retired receipt is never written back. */
export function withIdentifiedHandback(
  base: StoredNativeChatComposerDraft,
  handback: PendingNativeChatDraftHandback,
  retired = false
): StoredNativeChatComposerDraft {
  if (hasHandbackReceipt(base.handbacks, handback.receipt)) {
    return base
  }
  return {
    ...base,
    ...withIndependentNativeChatComposerDraft(base, handback.contribution),
    handbacks: retired
      ? [...(base.handbacks ?? [])]
      : withHandbackReceipts(base.handbacks, [handback.receipt]),
    sourcePaths: [...new Set([...(base.sourcePaths ?? []), ...handback.sourcePaths])]
  }
}

/** Receipts a write at `stored` keeps: the stored ones it did not retire, plus its own adoptions. */
export function handbacksAtBase(
  scopeKey: string,
  stored: StoredNativeChatComposerDraft | null
): NativeChatDraftHandbackReceipt[] {
  const custody = draftCustody.get(scopeKey)
  const kept = (stored?.handbacks ?? []).filter(
    (receipt) => !custody?.retired.has(handbackReceiptKey(receipt))
  )
  const own = (custody?.handbacks ?? []).filter((receipt) =>
    custody?.added.has(handbackReceiptKey(receipt))
  )
  return withHandbackReceipts(kept, own)
}

/** A move carries exact receipts, pending hand-backs and provenance; proof restarts at the destination. */
export function moveNativeChatDraftCustody(
  from: string,
  to: string,
  savedAt: number
): NativeChatDraftHandbackReceipt[] {
  const source = draftCustody.get(from)
  if (!source || from === to) {
    return []
  }
  const destination = scopeCustody(to, savedAt)
  destination.handbacks = withHandbackReceipts(destination.handbacks, source.handbacks)
  destination.sourcePaths = [...new Set([...destination.sourcePaths, ...source.sourcePaths])]
  destination.pending = [...destination.pending, ...source.pending]
  destination.owner ??= source.owner
  destination.savedAt = savedAt
  for (const receipt of source.handbacks) {
    const key = handbackReceiptKey(receipt)
    destination.added.add(key)
    destination.retired.delete(key)
    destination.durable.delete(key)
    destination.incorporated.delete(key)
    destination.committed.delete(key)
    if (source.retiring.has(key)) {
      destination.retiring.add(key)
    }
  }
  source.journaled.forEach((key) => destination.journaled.add(key))
  draftCustody.delete(from)
  return source.handbacks
}

/** Returned input brings back the provenance it left with; the install that follows keeps only named paths. */
export function restoreNativeChatDraftSourcePaths(
  scopeKey: string,
  paths: readonly string[]
): void {
  if (paths.length) {
    const custody = scopeCustody(scopeKey, 0)
    custody.sourcePaths = [...new Set([...custody.sourcePaths, ...paths])]
  }
}
