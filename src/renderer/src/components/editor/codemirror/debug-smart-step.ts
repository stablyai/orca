import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView } from '@codemirror/view'
import { useDebugSessionStore } from '@/store/debug/use-debug-session-store'

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

function targetIdFromEvent(event: Event): number | null {
  const el =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-step-target]') : null
  if (!el) {
    return null
  }
  const parsed = Number(el.dataset.stepTarget)
  return Number.isFinite(parsed) ? parsed : null
}

function buildStepTargetDecorations(view: EditorView, fileKey: string): DecorationSet {
  const inline = useDebugSessionStore.getState().smartStep?.inline
  if (!inline || inline.fileKey !== fileKey) {
    return Decoration.none
  }
  const doc = view.state.doc
  if (inline.line < 1 || inline.line > doc.lines) {
    return Decoration.none
  }
  const line = doc.line(inline.line)
  const builder = new RangeSetBuilder<Decoration>()
  inline.ranges.forEach((range, idx) => {
    if (range.to > line.length) {
      return
    }
    const selected = idx === inline.index
    builder.add(
      line.from + range.from,
      line.from + range.to,
      Decoration.mark({
        class: selected
          ? 'cm-debug-step-target cm-debug-step-target-selected'
          : 'cm-debug-step-target',
        attributes: {
          'data-step-target': String(range.id),
          ...(selected ? { 'aria-current': 'true' } : {})
        }
      })
    )
  })
  return builder.finish()
}

export function createDebugSmartStepExtension(fileKey: string): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      private unsub: () => void
      private teardownCapture: (() => void) | null = null
      private destroyed = false

      constructor(readonly view: EditorView) {
        this.decorations = buildStepTargetDecorations(view, fileKey)
        this.syncCaptureListeners()
        this.unsub = useDebugSessionStore.subscribe((s, prev) => {
          if (s.smartStep === prev.smartStep) {
            return
          }
          this.syncCaptureListeners()
          queueMicrotask(() => {
            if (!this.destroyed) {
              this.view.dispatch({})
            }
          })
        })
      }

      private isActiveInline(): boolean {
        return useDebugSessionStore.getState().smartStep?.inline?.fileKey === fileKey
      }

      private syncCaptureListeners(): void {
        const active = this.isActiveInline()
        if (active && !this.teardownCapture) {
          const onKeyDown = (e: KeyboardEvent): void => {
            const inline = useDebugSessionStore.getState().smartStep?.inline
            if (!inline || inline.fileKey !== fileKey || MODIFIER_KEYS.has(e.key)) {
              return
            }
            e.preventDefault()
            e.stopPropagation()
            const dbg = useDebugSessionStore.getState()
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
              dbg.selectSmartStepIndex(inline.index - 1)
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'Tab') {
              dbg.selectSmartStepIndex(inline.index + 1)
            } else if (e.key === 'Enter') {
              void dbg.chooseSmartStepTarget()
            } else {
              dbg.cancelSmartStep()
            }
          }

          const onMouseDown = (e: MouseEvent): void => {
            if (!this.isActiveInline()) {
              return
            }
            const id = targetIdFromEvent(e)
            const dbg = useDebugSessionStore.getState()
            if (id == null) {
              dbg.cancelSmartStep()
              return
            }
            e.preventDefault()
            e.stopPropagation()
            void dbg.chooseSmartStepTarget(id)
          }

          const onMouseOver = (e: MouseEvent): void => {
            const inline = useDebugSessionStore.getState().smartStep?.inline
            if (!inline || inline.fileKey !== fileKey) {
              return
            }
            const id = targetIdFromEvent(e)
            if (id == null) {
              return
            }
            const idx = inline.ranges.findIndex((r) => r.id === id)
            if (idx !== -1 && idx !== inline.index) {
              useDebugSessionStore.getState().selectSmartStepIndex(idx)
            }
          }

          window.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('mousedown', onMouseDown, true)
          window.addEventListener('mouseover', onMouseOver, true)
          this.teardownCapture = () => {
            window.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('mousedown', onMouseDown, true)
            window.removeEventListener('mouseover', onMouseOver, true)
          }
        } else if (!active && this.teardownCapture) {
          this.teardownCapture()
          this.teardownCapture = null
        }
      }

      update(): void {
        this.decorations = buildStepTargetDecorations(this.view, fileKey)
      }

      destroy(): void {
        this.destroyed = true
        this.unsub()
        this.teardownCapture?.()
        this.teardownCapture = null
      }
    },
    { decorations: (v) => v.decorations }
  )
}
