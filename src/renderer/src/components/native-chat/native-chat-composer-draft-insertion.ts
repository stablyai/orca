import type { NativeChatDraftReturnSource } from './native-chat-draft-return-products'
import { nativeChatComposerScopeDestination } from './native-chat-composer-destination'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { notifyDraftAppend } from './native-chat-composer-draft-memory'
import { appendPromptDocumentText } from './native-chat-prompt-document-text'
import { dictationSeparators } from '../../../../shared/dictation-transcript-spacing'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'

/** Captured new input uses ordinary insertion, never recovery replay deduplication. */
export function insertNativeChatComposerDraftText(
  scope: string,
  text: string,
  options?: {
    paste?: boolean
    owner?: NativeChatComposerDraftOwner
    draftOnly?: boolean
    sources?: readonly NativeChatDraftReturnSource[]
    dictated?: boolean
  }
): void {
  const mounted = options?.draftOnly ? null : nativeChatComposerScopeDestination(scope)
  const insertMounted = options?.paste
    ? (mounted?.insertPastedText ?? mounted?.insertTypedText)
    : mounted?.insertTypedText
  if (
    !mounted?.isComposing?.() &&
    insertMounted?.(text, {
      dictated: options?.dictated,
      ...(options?.sources ? { sources: options.sources } : {})
    })
  ) {
    return
  }
  const separator = (draftText: string): string => {
    if (options?.dictated) {
      return dictationSeparators(draftText, text, '').leading
    }
    return draftText && !/\s$/.test(draftText) && !/^\s/.test(text) ? ' ' : ''
  }
  const insert = <T extends NativeChatComposerDraft>(draft: T): T => {
    const next = `${draft.text}${separator(draft.text)}${text}`
    return {
      ...draft,
      ...(options?.owner ? { owner: options.owner } : {}),
      text: next,
      document: appendPromptDocumentText(draft.document, draft.text, next)
    }
  }
  const before = readNativeChatComposerDraft(scope)
  updateNativeChatComposerDraft(
    scope,
    insert(before),
    'immediate',
    insert,
    undefined,
    undefined,
    options?.sources
  )
  notifyDraftAppend(scope, insert, before)
}
