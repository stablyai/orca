import type { Extension, Range } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate
} from '@codemirror/view'
import { findGitConflictBlocks } from '../monaco/monaco-conflict-decorations'

export type ConflictLineClassEntry = {
  line: number
  className: string
}

const LINE_DECORATIONS: Record<string, Decoration> = {
  'cm-orca-conflict-marker': Decoration.line({ class: 'cm-orca-conflict-marker' }),
  'cm-orca-conflict-current': Decoration.line({ class: 'cm-orca-conflict-current' }),
  'cm-orca-conflict-base': Decoration.line({ class: 'cm-orca-conflict-base' }),
  'cm-orca-conflict-incoming': Decoration.line({ class: 'cm-orca-conflict-incoming' })
}

function pushRange(
  out: ConflictLineClassEntry[],
  fromLine: number,
  toLine: number,
  className: string
): void {
  for (let line = fromLine; line <= toLine; line += 1) {
    out.push({ line, className })
  }
}

/** Map unresolved Git merge conflict blocks into per-line CSS classes sorted by 1-based line number. */
export function buildConflictLineClasses(content: string): ConflictLineClassEntry[] {
  const entries: ConflictLineClassEntry[] = []
  for (const block of findGitConflictBlocks(content)) {
    const currentEnd = (block.baseLine ?? block.separatorLine) - 1
    entries.push({ line: block.startLine, className: 'cm-orca-conflict-marker' })
    pushRange(entries, block.startLine + 1, currentEnd, 'cm-orca-conflict-current')
    if (block.baseLine !== undefined) {
      entries.push({ line: block.baseLine, className: 'cm-orca-conflict-marker' })
      pushRange(entries, block.baseLine + 1, block.separatorLine - 1, 'cm-orca-conflict-base')
    }
    entries.push({ line: block.separatorLine, className: 'cm-orca-conflict-marker' })
    pushRange(entries, block.separatorLine + 1, block.endLine - 1, 'cm-orca-conflict-incoming')
    entries.push({ line: block.endLine, className: 'cm-orca-conflict-marker' })
  }
  return entries.sort((a, b) => a.line - b.line)
}

function buildConflictDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc
  const ranges: Range<Decoration>[] = []
  for (const entry of buildConflictLineClasses(doc.toString())) {
    if (entry.line < 1 || entry.line > doc.lines) {
      continue
    }
    const deco = LINE_DECORATIONS[entry.className]
    if (deco) {
      ranges.push(deco.range(doc.line(entry.line).from))
    }
  }
  return Decoration.set(ranges, true)
}

export function createConflictDecorationsExtension(enabled: boolean): Extension {
  if (!enabled) {
    return []
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(readonly view: EditorView) {
        this.decorations = buildConflictDecorations(view)
      }

      update(u: ViewUpdate): void {
        if (u.docChanged) {
          this.decorations = buildConflictDecorations(u.view)
        }
      }
    },
    { decorations: (v) => v.decorations }
  )
}
