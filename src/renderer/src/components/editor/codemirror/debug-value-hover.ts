import { EditorSelection, Prec, type Extension } from '@codemirror/state'
import { EditorView, hoverTooltip } from '@codemirror/view'
import { inlineValue } from '@/store/debug/debug-value-format'
import { useDebugSessionStore, type DebugVariable } from '@/store/debug/use-debug-session-store'
import type { DebugValueInspectRequest } from './debug-inline-values'

const IDENT_CHAR = /[\p{L}\p{N}_$]/u
const HOVER_DELAY_MS = 200
const TOOLTIP_MAX_VALUE_LEN = 320

let modifierPressed = false

if (typeof window !== 'undefined') {
  const syncModifier = (e: KeyboardEvent): void => {
    modifierPressed = e.altKey || e.ctrlKey || e.metaKey
  }
  window.addEventListener('keydown', syncModifier, true)
  window.addEventListener('keyup', syncModifier, true)
  window.addEventListener(
    'blur',
    () => {
      modifierPressed = false
    },
    true
  )
}

/** Resolve identifier chain (`a.b.c`) around `pos`, or a single-line active selection under `pos`. */
export function expressionAt(
  view: EditorView,
  pos: number
): { from: number; to: number; text: string } | null {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty && pos >= sel.from && pos <= sel.to) {
    const text = state.sliceDoc(sel.from, sel.to).trim()
    return text && !text.includes('\n') ? { from: sel.from, to: sel.to, text } : null
  }
  const line = state.doc.lineAt(pos)
  const text = line.text
  let start = pos - line.from
  let end = start
  if (!IDENT_CHAR.test(text[end] ?? '') && !IDENT_CHAR.test(text[start - 1] ?? '')) {
    return null
  }
  while (end < text.length && IDENT_CHAR.test(text[end] ?? '')) {
    end += 1
  }
  while (
    start > 0 &&
    (IDENT_CHAR.test(text[start - 1] ?? '') ||
      (text[start - 1] === '.' && IDENT_CHAR.test(text[start - 2] ?? '')))
  ) {
    start -= 1
  }
  const expr = text.slice(start, end)
  if (!expr || /^\d/.test(expr)) {
    return null
  }
  return { from: line.from + start, to: line.from + end, text: expr }
}

function buildValueTooltipDOM(
  expression: string,
  variable: DebugVariable,
  onInspectValue: (req: DebugValueInspectRequest) => void
): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cm-debug-value-tooltip'

  if (variable.variablesReference > 0) {
    const expand = document.createElement('button')
    expand.type = 'button'
    expand.className = 'cm-debug-value-expand'
    expand.textContent = '▸'
    expand.setAttribute('aria-label', `Inspect ${expression}`)
    expand.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = expand.getBoundingClientRect()
      onInspectValue({ expression, variable, x: rect.left, y: rect.bottom + 4 })
    })
    dom.append(expand)
  }

  const nameSpan = document.createElement('span')
  nameSpan.className = 'cm-debug-value-name'
  nameSpan.textContent = `${expression} = `
  dom.append(nameSpan, document.createTextNode(inlineValue(variable.value, TOOLTIP_MAX_VALUE_LEN)))

  if (variable.typeName) {
    const typeSpan = document.createElement('span')
    typeSpan.className = 'cm-debug-value-type'
    typeSpan.textContent = `  {${variable.typeName}}`
    dom.append(typeSpan)
  }

  return dom
}

export function createDebugValueHoverExtension(
  onInspectValue: (req: DebugValueInspectRequest) => void
): Extension {
  return hoverTooltip(
    async (view, pos) => {
      if (modifierPressed) {
        return null
      }
      const dbg = useDebugSessionStore.getState()
      if (dbg.status !== 'stopped' || dbg.activeSessionId === null) {
        return null
      }
      const expr = expressionAt(view, pos)
      if (!expr) {
        return null
      }
      let variable: DebugVariable
      try {
        variable = await dbg.evaluateIn(expr.text, 'hover')
      } catch {
        return null
      }
      if (modifierPressed || useDebugSessionStore.getState().status !== 'stopped') {
        return null
      }
      return {
        pos: expr.from,
        end: expr.to,
        above: true,
        create: () => ({ dom: buildValueTooltipDOM(expr.text, variable, onInspectValue) })
      }
    },
    { hoverTime: HOVER_DELAY_MS }
  )
}

export function createDebugQuickEvaluateExtension(
  onInspectValue: (req: DebugValueInspectRequest) => void
): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (
          event.button !== 0 ||
          !event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return false
        }
        const targetEl = event.target instanceof Element ? event.target : null
        if (!targetEl?.closest('.cm-content')) {
          return false
        }
        const dbg = useDebugSessionStore.getState()
        if (dbg.status !== 'stopped' || dbg.activeSessionId === null) {
          return false
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
        if (pos == null) {
          return false
        }
        const expr = expressionAt(view, pos)
        if (!expr) {
          return false
        }
        event.preventDefault()
        const sel = view.state.selection.main
        if (sel.empty || pos < sel.from || pos > sel.to) {
          view.dispatch({ selection: EditorSelection.cursor(pos) })
        }
        view.focus()
        const clientX = event.clientX
        const clientY = event.clientY
        void dbg
          .evaluateIn(expr.text, 'hover')
          .then((variable) =>
            onInspectValue({ expression: expr.text, variable, x: clientX, y: clientY + 6 })
          )
          .catch(() => {})
        return true
      }
    })
  )
}
