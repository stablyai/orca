import type React from 'react'
import type { Editor } from '@tiptap/react'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { stripMarkdownExtension } from './markdown-doc-links'

export type DocLinkMenuState = {
  query: string
  // Start at the first bracket so committing replaces the complete trigger text.
  from: number
  to: number
  left: number
  top: number
}

export type DocLinkMenuRow =
  | { kind: 'document'; document: MarkdownDocument }
  | { kind: 'action'; id: string; label: string; run: (editor: Editor) => void }

// Require block start, whitespace or an opening parenthesis before triggers; exclude nested brackets, label separators and newlines.
const DOC_LINK_TRIGGER_REGEX = /(^|[\s(])\[\[([^[\]|\r\n]*)$/

/** Insert the atom directly for one undo step without a transient preview-decoration flicker. */
export function runDocLinkCommand(
  editor: Editor,
  menu: { from: number; to: number },
  document: MarkdownDocument
): void {
  const target = stripMarkdownExtension(document.relativePath)
  editor
    .chain()
    .focus()
    .deleteRange({ from: menu.from, to: menu.to })
    .insertContentAt(menu.from, { type: 'markdownDocLink', attrs: { target } })
    .run()
}

export function commitRow(editor: Editor, menu: DocLinkMenuState, row: DocLinkMenuRow): void {
  if (row.kind === 'document') {
    runDocLinkCommand(editor, menu, row.document)
    return
  }
  editor.chain().focus().deleteRange({ from: menu.from, to: menu.to }).run()
  row.run(editor)
}

/** Clear the menu on every rejected trigger so leaving its region closes the old popover. */
export function syncDocLinkMenu(
  editor: Editor,
  root: HTMLDivElement | null,
  setDocLinkMenu: React.Dispatch<React.SetStateAction<DocLinkMenuState | null>>
): void {
  if (!root || editor.view.composing || !editor.isEditable) {
    setDocLinkMenu(null)
    return
  }

  const { state, view } = editor
  const { selection } = state
  if (!selection.empty) {
    setDocLinkMenu(null)
    return
  }

  const { $from } = selection
  if (!$from.parent.isTextblock) {
    setDocLinkMenu(null)
    return
  }

  // Code contexts treat wiki-link syntax as literal text.
  if ($from.parent.type.spec.code) {
    setDocLinkMenu(null)
    return
  }
  const codeMarkType = state.schema.marks.code
  if (codeMarkType && state.doc.rangeHasMark($from.pos, $from.pos, codeMarkType)) {
    setDocLinkMenu(null)
    return
  }

  const blockTextBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
  const match = blockTextBeforeCursor.match(DOC_LINK_TRIGGER_REGEX)
  if (!match) {
    setDocLinkMenu(null)
    return
  }

  // match.index includes the preceding boundary; lastIndexOf finds the unique opener without deleting that whitespace or parenthesis.
  const bracketOffset = blockTextBeforeCursor.lastIndexOf('[[')
  const from = selection.from - ($from.parentOffset - bracketOffset)

  const coords = view.coordsAtPos(selection.from)
  const rect = root.getBoundingClientRect()

  setDocLinkMenu({
    query: match[2] ?? '',
    from,
    to: selection.from,
    left: coords.left - rect.left,
    top: coords.bottom - rect.top + 8
  })
}
