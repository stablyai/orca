import { selectAll } from '@codemirror/commands'
import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { CodeGotoKind } from '@/store/code-intelligence/code-intelligence-types'
import { useCodeIntelligenceStore } from '@/store/code-intelligence/use-code-intelligence-store'

const IDENT_CHAR = /[\p{L}\p{N}_$]/u
const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

export type CodeNavigationContext = {
  filePath: string
  workspaceRoot: string | null
  language: string
  readOnly: boolean
}

export function isPrimaryNavModifier(
  e: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
): boolean {
  if (e.altKey || e.shiftKey) {
    return false
  }
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

export function wordAtPosition(
  doc: Text,
  pos: number
): { from: number; to: number; text: string } | null {
  const line = doc.lineAt(pos)
  const rel = pos - line.from
  const text = line.text
  let start = rel
  let end = rel
  if (!IDENT_CHAR.test(text[end] ?? '') && !IDENT_CHAR.test(text[start - 1] ?? '')) {
    return null
  }
  while (start > 0 && IDENT_CHAR.test(text[start - 1] ?? '')) {
    start -= 1
  }
  while (end < text.length && IDENT_CHAR.test(text[end] ?? '')) {
    end += 1
  }
  const word = text.slice(start, end)
  if (!word || /^\d/.test(word)) {
    return null
  }
  return { from: line.from + start, to: line.from + end, text: word }
}

export function stringLiteralAtPosition(
  doc: Text,
  pos: number
): { from: number; to: number; text: string } | null {
  const line = doc.lineAt(pos)
  const text = line.text
  if (!/\b(?:import|from|require|export)\b|#include/.test(text)) {
    return null
  }
  const rel = pos - line.from
  let active: { quote: string; start: number } | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (active) {
      if (ch === active.quote) {
        if (rel >= active.start && rel <= i) {
          return {
            from: line.from + active.start + 1,
            to: line.from + i,
            text: text.slice(active.start + 1, i)
          }
        }
        active = null
      }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      active = { quote: ch, start: i }
    }
  }
  return null
}

export function posToLineCol(doc: Text, pos: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(pos, doc.length))
  const line = doc.lineAt(clamped)
  return { line: line.number, column: clamped - line.from + 1 }
}

export function caretPopupAnchor(view: EditorView, pos?: number): { x: number; y: number } {
  const target = pos ?? view.state.selection.main.head
  const rect = view.coordsAtPos(target)
  if (rect) {
    return { x: rect.left, y: rect.bottom + 6 }
  }
  const box = view.dom.getBoundingClientRect()
  return { x: box.left + 32, y: box.top + 32 }
}

export type CodeActionKind = CodeGotoKind | 'references' | 'rename' | 'outline'

export function triggerCodeAction(
  view: EditorView,
  ctx: CodeNavigationContext,
  action: CodeActionKind,
  pos?: number,
  coords?: { x: number; y: number }
): void {
  const store = useCodeIntelligenceStore.getState()
  const offset = pos ?? view.state.selection.main.head
  const { line, column } = posToLineCol(view.state.doc, offset)
  const word = wordAtPosition(view.state.doc, offset)?.text ?? ''
  const anchor = coords ?? caretPopupAnchor(view, offset)
  const text = view.state.doc.toString()

  if (action === 'outline') {
    void store.openOutline({
      filePath: ctx.filePath,
      workspaceRoot: ctx.workspaceRoot,
      language: ctx.language,
      text
    })
    return
  }
  if (action === 'references') {
    void store.runFindReferences({
      filePath: ctx.filePath,
      workspaceRoot: ctx.workspaceRoot,
      language: ctx.language,
      text,
      line,
      column,
      word,
      anchor
    })
    return
  }
  if (action === 'rename') {
    if (ctx.readOnly) {
      store.showStatusHint({ text: 'Cannot rename symbols in a read-only file', tone: 'warning' })
      return
    }
    void store.beginRename({
      filePath: ctx.filePath,
      workspaceRoot: ctx.workspaceRoot,
      language: ctx.language,
      text,
      line,
      column,
      word,
      anchor
    })
    return
  }
  void store.runGoto({
    kind: action,
    filePath: ctx.filePath,
    workspaceRoot: ctx.workspaceRoot,
    language: ctx.language,
    text,
    line,
    column,
    word,
    anchor
  })
}

export function runCodeEditorClipboardCommand(
  view: EditorView | null,
  readOnly: boolean,
  command: 'cut' | 'copy' | 'paste' | 'select-all'
): void {
  if (!view) {
    return
  }
  const sel = view.state.selection.main
  if (command === 'select-all') {
    selectAll(view)
    view.focus()
    return
  }
  if (command === 'copy' || command === 'cut') {
    const selected = view.state.sliceDoc(sel.from, sel.to)
    if (selected) {
      void navigator.clipboard.writeText(selected).catch(() => {})
    }
    if (command === 'cut' && !readOnly && sel.from < sel.to) {
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
    }
    view.focus()
    return
  }
  if (command === 'paste' && !readOnly) {
    void navigator.clipboard
      .readText()
      .then((clip) => {
        if (view.dom.isConnected && clip) {
          view.dispatch({ changes: { from: sel.from, to: sel.to, insert: clip } })
        }
        view.focus()
      })
      .catch(() => {})
  }
}
