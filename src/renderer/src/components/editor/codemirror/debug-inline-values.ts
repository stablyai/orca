import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate
} from '@codemirror/view'
import { collectFrameLocals, identifiersIn, inlineValue } from '@/store/debug/debug-value-format'
import { useDebugSessionStore, type DebugVariable } from '@/store/debug/use-debug-session-store'

const INLINE_LOOKBACK_LINES = 60
const MAX_VALUES_PER_LINE = 4
const INLINE_MAX_VALUE_LEN = 40

export type DebugValueInspectRequest = {
  expression: string
  variable: DebugVariable
  x: number
  y: number
}

type InlineValuePart = {
  name: string
  text: string
  variable: DebugVariable
  truncated: boolean
}

class InlineValuesWidget extends WidgetType {
  constructor(
    readonly parts: InlineValuePart[],
    readonly onInspectValue: (req: DebugValueInspectRequest) => void
  ) {
    super()
  }

  eq(other: InlineValuesWidget): boolean {
    return (
      other.parts.length === this.parts.length &&
      other.parts.every(
        (p, idx) => p.name === this.parts[idx]?.name && p.text === this.parts[idx]?.text
      )
    )
  }

  toDOM(): HTMLElement {
    const root = document.createElement('span')
    root.className = 'cm-debug-inline-values'
    this.parts.forEach((part, idx) => {
      if (idx > 0) {
        root.append(document.createTextNode(', '))
      }
      const chip = document.createElement('span')
      chip.className = 'cm-debug-inline-part'
      chip.textContent = part.text
      chip.title = `${part.name} = ${part.variable.value}`
      chip.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const rect = chip.getBoundingClientRect()
        this.onInspectValue({
          expression: part.name,
          variable: part.variable,
          x: rect.left,
          y: rect.bottom + 4
        })
      })
      root.append(chip)
      if (part.truncated) {
        const more = document.createElement('span')
        more.className = 'cm-debug-inline-more'
        more.textContent = '…'
        more.addEventListener('mousedown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          const rect = more.getBoundingClientRect()
          this.onInspectValue({
            expression: part.name,
            variable: part.variable,
            x: rect.left,
            y: rect.bottom + 4
          })
        })
        root.append(more)
      }
    })
    return root
  }

  ignoreEvent(): boolean {
    return true
  }
}

const stoppedLineDecoration = Decoration.line({ class: 'cm-debug-stopped-line' })
const setStoppedLineEffect = StateEffect.define<number | null>()

function stoppedLineForFile(fileKey: string): number | null {
  const stopped = useDebugSessionStore.getState().stoppedLocation
  return stopped && stopped.fileKey === fileKey ? stopped.line : null
}

function buildStoppedLineDecos(state: EditorState, lineNum: number | null): DecorationSet {
  if (lineNum == null || lineNum < 1 || lineNum > state.doc.lines) {
    return Decoration.none
  }
  return Decoration.set([stoppedLineDecoration.range(state.doc.line(lineNum).from)])
}

function inlineValuesForLine(
  lineText: string,
  locals: Record<string, DebugVariable>
): InlineValuePart[] | null {
  const parts: InlineValuePart[] = []
  for (const name of identifiersIn(lineText)) {
    if (!Object.hasOwn(locals, name)) {
      continue
    }
    const variable = locals[name]
    if (!variable) {
      continue
    }
    parts.push({
      name,
      text: `${name}: ${inlineValue(variable.value, INLINE_MAX_VALUE_LEN)}`,
      variable,
      truncated: variable.value.length > INLINE_MAX_VALUE_LEN
    })
    if (parts.length >= MAX_VALUES_PER_LINE) {
      break
    }
  }
  return parts.length > 0 ? parts : null
}

export function createDebugInlineValuesExtension(
  fileKey: string,
  onInspectValue: (req: DebugValueInspectRequest) => void
): Extension {
  const stoppedField = StateField.define<number | null>({
    create: () => stoppedLineForFile(fileKey),
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setStoppedLineEffect)) {
          return e.value
        }
      }
      if (value != null && tr.docChanged && value >= 1 && value <= tr.startState.doc.lines) {
        const pos = tr.changes.mapPos(tr.startState.doc.line(value).from, 1)
        return tr.state.doc.lineAt(Math.min(pos, tr.state.doc.length)).number
      }
      return value
    },
    provide: (f) => EditorView.decorations.compute([f], (s) => buildStoppedLineDecos(s, s.field(f)))
  })

  const inlinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = RangeSet.empty
      private unsub: () => void
      private pending = false
      private destroyed = false

      constructor(readonly view: EditorView) {
        this.decorations = this.build()
        this.unsub = useDebugSessionStore.subscribe((s, prev) => {
          if (
            s.stoppedLocation !== prev.stoppedLocation ||
            s.scopes !== prev.scopes ||
            s.variablesByRef !== prev.variablesByRef ||
            s.status !== prev.status
          ) {
            this.scheduleSync()
          }
        })
      }

      private scheduleSync(): void {
        if (this.pending) {
          return
        }
        this.pending = true
        queueMicrotask(() => {
          this.pending = false
          if (this.destroyed) {
            return
          }
          const nextLine = stoppedLineForFile(fileKey)
          const curLine = this.view.state.field(stoppedField)
          const effects: StateEffect<unknown>[] = []
          if (curLine !== nextLine) {
            effects.push(setStoppedLineEffect.of(nextLine))
            if (nextLine !== null && nextLine >= 1 && nextLine <= this.view.state.doc.lines) {
              effects.push(
                EditorView.scrollIntoView(this.view.state.doc.line(nextLine).from, { y: 'center' })
              )
            }
          }
          this.view.dispatch(effects.length > 0 ? { effects } : {})
        })
      }

      update(u: ViewUpdate): void {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.startState.field(stoppedField) !== u.state.field(stoppedField) ||
          u.transactions.length > 0
        ) {
          this.decorations = this.build()
        }
      }

      private build(): DecorationSet {
        const stoppedLine = this.view.state.field(stoppedField)
        const dbg = useDebugSessionStore.getState()
        if (stoppedLine == null || dbg.status !== 'stopped') {
          return Decoration.none
        }
        const locals = collectFrameLocals(dbg.scopes, dbg.variablesByRef)
        if (Object.keys(locals).length === 0) {
          return Decoration.none
        }
        const doc = this.view.state.doc
        const minLine = Math.max(1, stoppedLine - INLINE_LOOKBACK_LINES)
        const maxLine = Math.min(doc.lines, stoppedLine)
        const widgets: Range<Decoration>[] = []
        for (const { from, to } of this.view.visibleRanges) {
          const start = Math.max(doc.lineAt(from).number, minLine)
          const end = Math.min(doc.lineAt(to).number, maxLine)
          for (let lineNum = start; lineNum <= end; lineNum += 1) {
            const line = doc.line(lineNum)
            const parts = inlineValuesForLine(line.text, locals)
            if (parts) {
              widgets.push(
                Decoration.widget({
                  widget: new InlineValuesWidget(parts, onInspectValue),
                  side: 1
                }).range(line.to)
              )
            }
          }
        }
        return Decoration.set(widgets, true)
      }

      destroy(): void {
        this.destroyed = true
        this.unsub()
      }
    },
    { decorations: (v) => v.decorations }
  )

  return [stoppedField, inlinePlugin]
}
