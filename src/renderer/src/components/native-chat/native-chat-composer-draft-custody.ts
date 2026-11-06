// A draft's hand-back receipts and client-source provenance: kept beside its visible content, saved with it.

import { nativeChatTextAttachmentParts } from '../../../../shared/native-chat-text-attachment-references'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftOwner,
  NativeChatDraftHandbackReceipt,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

export type NativeChatDraftCustody = {
  handbacks: NativeChatDraftHandbackReceipt[]
  sourcePaths: string[]
  owner?: NativeChatComposerDraftOwner
  savedAt: number
  /** Receipts a committed draft or written journal entry holds. */
  readonly durable: Set<string>
  /** Receipts this window adopted or moved here; a foreign write lacking one does not drop it. */
  readonly owned: Set<string>
}

export const draftCustody = new Map<string, NativeChatDraftCustody>()

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
    custody = { handbacks: [], sourcePaths: [], savedAt, durable: new Set(), owned: new Set() }
    draftCustody.set(scopeKey, custody)
  }
  return custody
}

export function dropEmptyNativeChatDraftCustody(scopeKey: string): void {
  const custody = draftCustody.get(scopeKey)
  if (custody && custody.handbacks.length === 0 && custody.sourcePaths.length === 0) {
    draftCustody.delete(scopeKey)
  }
}

/** Provenance lives only as long as the draft still names the path; edits and clears consume it. */
export function pruneNativeChatDraftSourcePaths(
  scopeKey: string,
  draft: NativeChatComposerDraft | undefined
): void {
  const custody = draftCustody.get(scopeKey)
  if (!custody?.sourcePaths.length) {
    return
  }
  const referenced = referencedNativeChatDraftPaths(draft)
  custody.sourcePaths = custody.sourcePaths.filter((path) => referenced.has(path))
  dropEmptyNativeChatDraftCustody(scopeKey)
}

/** The record a write saves: content plus custody, or a metadata-only record while a receipt is owed. */
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

/** Install a stored record's custody as this window's; `durable` lists the receipts storage already proves. */
export function adoptStoredNativeChatDraftCustody(
  scopeKey: string,
  stored: StoredNativeChatComposerDraft,
  durable: readonly NativeChatDraftHandbackReceipt[]
): void {
  const previous = draftCustody.get(scopeKey)
  draftCustody.delete(scopeKey)
  if (!stored.handbacks?.length && !stored.sourcePaths?.length) {
    return
  }
  const custody = scopeCustody(scopeKey, stored.savedAt)
  custody.handbacks = [...(stored.handbacks ?? [])]
  custody.sourcePaths = [...(stored.sourcePaths ?? [])]
  custody.owner = stored.owner
  for (const receipt of custody.handbacks) {
    const key = handbackReceiptKey(receipt)
    if (hasHandbackReceipt(durable, receipt) || previous?.durable.has(key)) {
      custody.durable.add(key)
    }
    if (previous?.owned.has(key)) {
      custody.owned.add(key)
    }
  }
}

/** Receipts this window still asserts that `stored` lacks: a stale writer must not erase them. */
export function ownedHandbacksMissingFrom(
  scopeKey: string,
  stored: StoredNativeChatComposerDraft | null
): NativeChatDraftHandbackReceipt[] {
  const custody = draftCustody.get(scopeKey)
  return (custody?.handbacks ?? []).filter(
    (receipt) =>
      custody?.owned.has(handbackReceiptKey(receipt)) &&
      !hasHandbackReceipt(stored?.handbacks, receipt)
  )
}

/** A written or committed record proves each receipt it holds that the draft still holds. */
export function markNativeChatDraftHandbacksDurable(
  scopeKey: string,
  written: StoredNativeChatComposerDraft | null | undefined
): void {
  const custody = draftCustody.get(scopeKey)
  for (const receipt of written?.handbacks ?? []) {
    if (custody && hasHandbackReceipt(custody.handbacks, receipt)) {
      custody.durable.add(handbackReceiptKey(receipt))
    }
  }
}

export function hasUndurableNativeChatDraftHandback(scopeKey: string): boolean {
  const custody = draftCustody.get(scopeKey)
  return (
    custody?.handbacks.some((receipt) => !custody.durable.has(handbackReceiptKey(receipt))) ?? false
  )
}

/** A move carries exact receipts and provenance with the content; proof restarts at the destination. */
export function moveNativeChatDraftCustody(from: string, to: string, savedAt: number): boolean {
  const source = draftCustody.get(from)
  if (!source || from === to) {
    return false
  }
  const destination = scopeCustody(to, savedAt)
  destination.handbacks = withHandbackReceipts(destination.handbacks, source.handbacks)
  destination.sourcePaths = [...new Set([...destination.sourcePaths, ...source.sourcePaths])]
  destination.owner ??= source.owner
  destination.savedAt = savedAt
  source.handbacks.forEach((receipt) => {
    const key = handbackReceiptKey(receipt)
    destination.owned.add(key)
    destination.durable.delete(key)
  })
  draftCustody.delete(from)
  return source.handbacks.length > 0
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

/** Re-adds receipts this window adopted that a foreign write dropped; the caller saves them again. */
export function reassertNativeChatDraftHandbacks(
  scopeKey: string,
  missing: readonly NativeChatDraftHandbackReceipt[],
  savedAt: number
): void {
  const custody = scopeCustody(scopeKey, savedAt)
  custody.handbacks = withHandbackReceipts(custody.handbacks, missing)
  missing.forEach((receipt) => custody.owned.add(handbackReceiptKey(receipt)))
  custody.savedAt = savedAt
}
