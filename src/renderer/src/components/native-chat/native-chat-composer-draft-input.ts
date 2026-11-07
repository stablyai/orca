// A scope's unsaved input while its saved base is unread: an addition's partial view, composed onto
// that base once it is read, or a replacement of its content (ordinary typing wins) whose saved
// receipts are still to be read. Held only while unresolved; once an actual read resolves it, the
// draft is the complete value and stands alone.

import { draftCustody } from './native-chat-composer-draft-custody'
import {
  isNativeChatMemoryOnlyDraft,
  load,
  records,
  type DraftAppend
} from './native-chat-composer-draft-memory'

export type NativeChatDraftInput =
  /** Added over the unread base. `appends` replays each addition onto the base; once its view is
   *  edited before that read, the edited view joins the base as one independent input (`null`). */
  | { readonly kind: 'partial'; appends: DraftAppend[] | null }
  /** Typed, sent or cleared over the unread base: its content goes (its images too, unless only
   *  text was consumed); receipts it still owes stay. */
  | { readonly kind: 'replaced'; images: boolean }

export const scopeInputs = new Map<string, NativeChatDraftInput>()

/** Every producer, before it installs a changed record: over an unread base an addition is input
 *  to compose there and an ordinary edit replaces its content; over a complete value either is
 *  simply the new complete value. */
export function noteNativeChatDraftInput(scopeKey: string, append?: DraftAppend): void {
  if (load.complete || isNativeChatMemoryOnlyDraft(scopeKey)) {
    return
  }
  const input = scopeInputs.get(scopeKey)
  if (!input) {
    if (!records.has(scopeKey)) {
      scopeInputs.set(
        scopeKey,
        append ? { kind: 'partial', appends: [append] } : { kind: 'replaced', images: true }
      )
    }
    return
  }
  if (input.kind === 'partial') {
    input.appends = append && input.appends ? [...input.appends, append] : null
  }
}

/** What an applied Send or accepted command consumed: the whole input, or its text only. */
export type NativeChatDraftConsumption = 'all' | 'text'

/** An applied consumption over an unread base replaces that base's content: all of it, or only its
 *  text when the action keeps attachments. Never called for a consumption another edit beat. */
export function replaceNativeChatDraftInput(
  scopeKey: string,
  consumed: NativeChatDraftConsumption = 'all'
): void {
  if (load.complete || isNativeChatMemoryOnlyDraft(scopeKey)) {
    return
  }
  const input = scopeInputs.get(scopeKey)
  if (input || !records.has(scopeKey)) {
    const images = consumed === 'all' || (input?.kind === 'replaced' && input.images)
    scopeInputs.set(scopeKey, { kind: 'replaced', images })
  }
}

/** Whether memory holds the scope's resolved base: never while input or a return waits for its
 *  read; once every draft loaded; otherwise when a record no unresolved input describes exists,
 *  which only a resolving producer (an actual read, or edits of its result) can make. */
export function nativeChatDraftBaseKnown(scopeKey: string): boolean {
  if (draftCustody.get(scopeKey)?.pending.length || scopeInputs.has(scopeKey)) {
    return false
  }
  return load.complete || records.has(scopeKey)
}
