import { formatNativeChatFileReference } from '../../../../../../shared/native-chat/input/composer/agent-image-paste'
import type { OrchestrationAgentReference } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import type { HTMLAttributes, RefObject } from 'react'
import { linkedSelectionText } from '../../paste/native-chat-pasted-links'
import { applyMentionSuggestion } from '../../../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'

/** Text coordinates keep transport, attachments, and picker logic independent of the editor. */
export type NativeChatComposerInput = Pick<
  HTMLTextAreaElement,
  | 'value'
  | 'selectionStart'
  | 'selectionEnd'
  | 'disabled'
  | 'focus'
  | 'select'
  | 'setSelectionRange'
> & {
  insertAgentReferences?: (references: OrchestrationAgentReference[]) => void
  contains?: (node: Node | null) => boolean
  insertText?: (text: string) => void
  insertSkill?: (from: number, to: number, token: string, path?: string) => void
  /** Replaces `from`..`to` with a picked mention's token and a space, a bot's token as its pill. */
  insertMention?: (from: number, to: number, token: string) => void
  /** Deletes every chip of one image, as when its thumbnail goes. */
  removeImageReferences?: (attachmentId: string) => void
  /** Inserts each file at the caret as a pill; its text stays the `@path` reference. */
  insertFileReferences?: (paths: string[]) => void
  /** One user paste transaction; ordinary history retains the replaced rich selection. */
  stagePastedText?: (token: string) => void
  /** True only for collapsed carets at the first/last visual line, including wraps. */
  isCaretOnVisualEdge?: (edge: 'start' | 'end') => boolean
}

export type NativeChatPromptEditorProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange' | 'onSelect'
> & {
  scopeKey?: string
  positionTarget?: string
  /** The composer's thumbnail ids, in order, which number its image chips. */
  imageRow?: readonly string[]
  inputRef: RefObject<NativeChatComposerInput | null>
  isComposing?: () => boolean
  initialValue: string
  disabled: boolean
  placeholder: string
  onChange: (input: NativeChatComposerInput) => void
  onSelect: (input: NativeChatComposerInput) => void
}

export function insertNativeChatPastedText(
  input: NativeChatComposerInput | null,
  text: string
): boolean {
  if (!input || input.disabled || !input.insertText) {
    return false
  }
  // A paste routed from a hidden terminal or a transcript click must leave the caret in the composer.
  input.focus()
  const { selectionStart, selectionEnd } = input
  const linked =
    selectionStart !== null && selectionEnd !== null && selectionStart < selectionEnd
      ? linkedSelectionText(input.value.slice(selectionStart, selectionEnd), text)
      : null
  input.insertText(linked ?? text)
  return true
}

/** Text and caret in one synchronous write, then focus, so the next native key lands after them. */
export function writeNativeChatComposerText(
  input: NativeChatComposerInput,
  text: string,
  caret: number
): void {
  input.value = text
  input.setSelectionRange(caret, caret)
  input.focus()
}

/** The draft after picking `path` under `@`. A member's token (a bot's, a room's `@Name`) goes in
 *  through the editor first, as its own undo step and over exactly the `@query` it replaces; the
 *  commit that follows then finds the text already in place. With no editor, the commit's write
 *  alone puts the token in, which still makes a bot's pill (mid-IME the editor takes nothing). A
 *  file's `@path` is left to that commit as plain text. */
export function applyNativeChatMention(
  input: NativeChatComposerInput | null,
  text: string,
  at: number,
  path: string,
  token?: string,
  /** Where the replaced text starts when it isn't the `@query` before the caret: a bot's chat,
   *  picked one level under it, whose filter may hold spaces the `@query` can't. */
  from?: number
): { draft: string; caret: number } {
  if (from !== undefined) {
    // A file goes in as its plain `@path`, as below; a member's token through the editor.
    const inserted = token ?? formatNativeChatFileReference(path)
    const before = `${text.slice(0, from)}${inserted} `
    if (token) {
      insertMentionToken(input, text, from, at, token)
    }
    return { draft: before + text.slice(at).replace(/^ /, ''), caret: before.length }
  }
  const result = applyMentionSuggestion(text, at, path, token)
  if (token && result.draft !== text) {
    insertMentionToken(input, text, result.caret - token.length - 1, at, token)
  }
  return result
}

function insertMentionToken(
  input: NativeChatComposerInput | null,
  text: string,
  from: number,
  to: number,
  token: string
): void {
  // The draft swallows one space after the caret, as the inserted token brings one.
  input?.insertMention?.(from, text.startsWith(' ', to) ? to + 1 : to, token)
}
