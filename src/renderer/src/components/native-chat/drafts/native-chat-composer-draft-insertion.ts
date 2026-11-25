import { nativeChatComposerScopeDestination } from '../composer/focus/native-chat-composer-destination'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { notifyDraftAppend } from './native-chat-composer-draft-memory'
import { appendPromptDocumentText } from '../composer/editor/native-chat-prompt-document-text'
import { toLfPastedText } from '@/lib/clipboard/clipboard-line-endings'
import { dictationSeparators } from '../../../../../shared/speech/dictation/dictation-transcript-spacing'
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
    dictated?: boolean
  }
): void {
  const mounted = options?.draftOnly ? null : nativeChatComposerScopeDestination(scope)
  const insertMounted = options?.paste
    ? (mounted?.insertPastedText ?? mounted?.insertTypedText)
    : mounted?.insertTypedText
  if (!mounted?.isComposing?.() && insertMounted?.(text, { dictated: options?.dictated })) {
    return
  }
  const inserted = options?.paste ? toLfPastedText(text) : text
  const separator = (draftText: string): string => {
    if (options?.dictated) {
      return dictationSeparators(draftText, inserted, '').leading
    }
    return draftText && !/\s$/.test(draftText) && !/^\s/.test(inserted) ? ' ' : ''
  }
  const insert = <T extends NativeChatComposerDraft>(draft: T): T => {
    const next = `${draft.text}${separator(draft.text)}${inserted}`
    return {
      ...draft,
      ...(options?.owner ? { owner: options.owner } : {}),
      text: next,
      document: appendPromptDocumentText(draft.document, draft.text, next)
    }
  }
  const before = readNativeChatComposerDraft(scope)
  updateNativeChatComposerDraft(scope, insert(before), 'immediate', insert)
  notifyDraftAppend(scope, insert, before)
}
