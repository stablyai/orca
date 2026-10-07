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
  insertSkill?: (from: number, to: number, token: string) => void
  /** Whether a collapsed caret sits on the first (`start`) or last (`end`) visual line,
   *  counting wrapped lines, so an arrow key there has nowhere left to move it. */
  isCaretOnVisualEdge?: (edge: 'start' | 'end') => boolean
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
