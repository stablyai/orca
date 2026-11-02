import type { HTMLAttributes, RefObject } from 'react'

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
  contains?: (node: Node | null) => boolean
  insertText?: (text: string) => void
  insertSkill?: (from: number, to: number, token: string, path?: string) => void
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
  input.insertText(text)
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
