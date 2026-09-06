import type { Editor } from '@tiptap/react'

export type TerminalRichInputQuery = {
  from: number
  to: number
  query: string
}

export function sameTerminalRichInputAutocompleteQuery(
  left: TerminalRichInputQuery | null,
  right: TerminalRichInputQuery | null
): boolean {
  return left?.from === right?.from && left?.to === right?.to && left?.query === right?.query
}

export function findTerminalRichInputMentionQuery(editor: Editor): TerminalRichInputQuery | null {
  if (!editor.state.selection.empty) {
    return null
  }
  return findTerminalRichInputQuery(editor, '@')
}

export function findTerminalRichInputSlashQuery(editor: Editor): TerminalRichInputQuery | null {
  if (!editor.state.selection.empty) {
    return null
  }
  const { from } = editor.state.selection
  const before = editor.state.doc.textBetween(0, from, '\n', '\ufffc')
  const match = before.match(/^\/(\S*)$/)
  if (!match) {
    return null
  }
  const query = match[1]
  return { from: from - query.length - 1, to: from, query }
}

export function findTerminalRichInputAutocomplete(
  editor: Editor,
  enabled: boolean
): { mention: TerminalRichInputQuery | null; slash: TerminalRichInputQuery | null } {
  if (!enabled) {
    return { mention: null, slash: null }
  }
  const mention = findTerminalRichInputMentionQuery(editor)
  return {
    mention,
    slash: mention ? null : findTerminalRichInputSlashQuery(editor)
  }
}

function findTerminalRichInputQuery(editor: Editor, trigger: '@'): TerminalRichInputQuery | null {
  const { $from } = editor.state.selection
  if (!$from.parent.isTextblock) {
    return null
  }
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, (node) =>
    node.type.name === 'hardBreak' ? '\n' : '\ufffc'
  )
  const match = before.match(new RegExp(`(^|\\s)${trigger}(\\S*)$`))
  if (!match) {
    return null
  }
  const query = match[2]
  return {
    from: editor.state.selection.from - query.length - 1,
    to: editor.state.selection.from,
    query
  }
}
