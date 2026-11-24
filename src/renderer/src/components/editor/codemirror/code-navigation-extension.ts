import { EditorSelection, Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet } from '@codemirror/view'
import { useCodeIntelligenceStore } from '@/store/code-intelligence/use-code-intelligence-store'
import {
  isPrimaryNavModifier,
  posToLineCol,
  stringLiteralAtPosition,
  triggerCodeAction,
  wordAtPosition,
  type CodeNavigationContext
} from './code-navigation-actions'

const setNavLinkEffect = StateEffect.define<{ from: number; to: number } | null>()
const navLinkMark = Decoration.mark({ class: 'cm-lsp-link' })

const navLinkField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setNavLinkEffect)) {
        return effect.value
      }
    }
    return tr.docChanged ? null : value
  },
  provide: (field) =>
    EditorView.decorations.from(field, (val): DecorationSet =>
      val ? Decoration.set([navLinkMark.range(val.from, val.to)]) : Decoration.none
    )
})

function linkRangeAtCoords(
  view: EditorView,
  x: number,
  y: number
): { from: number; to: number } | null {
  const pos = view.posAtCoords({ x, y }, false)
  if (pos === null) {
    return null
  }
  const strRange = stringLiteralAtPosition(view.state.doc, pos)
  if (strRange && strRange.from < strRange.to) {
    return { from: strRange.from, to: strRange.to }
  }
  const word = wordAtPosition(view.state.doc, pos)
  return word && word.from < word.to ? { from: word.from, to: word.to } : null
}

function createCtrlHoverAndClickPlugin(getContext: () => CodeNavigationContext): Extension {
  const hoverPlugin = ViewPlugin.fromClass(
    class {
      lastCoords: { x: number; y: number } | null = null
      cleanup: () => void

      constructor(readonly view: EditorView) {
        const updateLink = (nextHeld: boolean): void => {
          const nextRange =
            nextHeld && this.lastCoords
              ? linkRangeAtCoords(this.view, this.lastCoords.x, this.lastCoords.y)
              : null
          const cur = this.view.state.field(navLinkField, false) ?? null
          if (cur?.from === nextRange?.from && cur?.to === nextRange?.to) {
            return
          }
          requestAnimationFrame(() => {
            if (this.view.dom.isConnected) {
              this.view.dispatch({ effects: setNavLinkEffect.of(nextRange) })
            }
          })
        }

        const onMouseMove = (e: MouseEvent): void => {
          this.lastCoords = { x: e.clientX, y: e.clientY }
          updateLink(isPrimaryNavModifier(e))
        }
        const onMouseLeave = (): void => {
          this.lastCoords = null
          updateLink(false)
        }
        const onKeyChange = (e: KeyboardEvent): void => updateLink(isPrimaryNavModifier(e))
        const onBlur = (): void => updateLink(false)

        view.contentDOM.addEventListener('mousemove', onMouseMove)
        view.contentDOM.addEventListener('mouseleave', onMouseLeave)
        window.addEventListener('keydown', onKeyChange, true)
        window.addEventListener('keyup', onKeyChange, true)
        window.addEventListener('blur', onBlur)

        this.cleanup = () => {
          view.contentDOM.removeEventListener('mousemove', onMouseMove)
          view.contentDOM.removeEventListener('mouseleave', onMouseLeave)
          window.removeEventListener('keydown', onKeyChange, true)
          window.removeEventListener('keyup', onKeyChange, true)
          window.removeEventListener('blur', onBlur)
        }
      }

      destroy(): void {
        this.cleanup()
      }
    }
  )

  const pointerHandlers = Prec.highest(
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !isPrimaryNavModifier(event)) {
          return false
        }
        const target = event.target instanceof Element ? event.target : null
        if (!target?.closest('.cm-content')) {
          return false
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
        if (pos === null) {
          return false
        }
        const link =
          stringLiteralAtPosition(view.state.doc, pos) ?? wordAtPosition(view.state.doc, pos)
        if (!link) {
          return false
        }
        event.preventDefault()
        event.stopPropagation()
        view.dispatch({ selection: EditorSelection.cursor(pos) })
        view.focus()
        triggerCodeAction(view, getContext(), 'definition', pos, {
          x: event.clientX,
          y: event.clientY + 6
        })
        return true
      },
      contextmenu(event, view) {
        const target = event.target instanceof Element ? event.target : null
        if (!target?.closest('.cm-content')) {
          return false
        }
        event.preventDefault()
        const ctx = getContext()
        const clickedPos =
          view.posAtCoords({ x: event.clientX, y: event.clientY }, false) ??
          view.state.selection.main.head
        const sel = view.state.selection.main
        if (sel.empty || clickedPos < sel.from || clickedPos > sel.to) {
          view.dispatch({ selection: EditorSelection.cursor(clickedPos) })
        }
        const { line, column } = posToLineCol(view.state.doc, clickedPos)
        const word = wordAtPosition(view.state.doc, clickedPos)?.text ?? ''
        useCodeIntelligenceStore.getState().openContextMenu({
          filePath: ctx.filePath,
          workspaceRoot: ctx.workspaceRoot,
          language: ctx.language,
          text: view.state.doc.toString(),
          line,
          column,
          word,
          readOnly: ctx.readOnly,
          hasSelection: !view.state.selection.main.empty,
          x: event.clientX,
          y: event.clientY
        })
        return true
      }
    })
  )

  return [navLinkField, hoverPlugin, pointerHandlers]
}

export function createCodeNavigationExtension(getContext: () => CodeNavigationContext): Extension {
  const navKeymap = Prec.high(
    keymap.of([
      {
        key: 'Mod-b',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'definition')
          return true
        }
      },
      {
        key: 'F12',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'definition')
          return true
        }
      },
      {
        key: 'Mod-Shift-b',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'typeDefinition')
          return true
        }
      },
      {
        key: 'Mod-Alt-b',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'implementation')
          return true
        }
      },
      {
        key: 'Shift-F12',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'references')
          return true
        }
      },
      {
        key: 'Alt-F7',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'references')
          return true
        }
      },
      {
        key: 'Mod-F12',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'outline')
          return true
        }
      },
      {
        key: 'Mod-Shift-o',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'outline')
          return true
        }
      },
      {
        key: 'F2',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'rename')
          return true
        }
      },
      {
        key: 'Shift-F6',
        run: (view) => {
          triggerCodeAction(view, getContext(), 'rename')
          return true
        }
      },
      {
        key: 'Alt-ArrowLeft',
        run: () => useCodeIntelligenceStore.getState().navigateBack()
      },
      {
        key: 'Mod-Alt-ArrowLeft',
        run: () => useCodeIntelligenceStore.getState().navigateBack()
      },
      {
        key: 'Mod-[',
        run: () => useCodeIntelligenceStore.getState().navigateBack()
      },
      {
        key: 'Alt-ArrowRight',
        run: () => useCodeIntelligenceStore.getState().navigateForward()
      },
      {
        key: 'Mod-Alt-ArrowRight',
        run: () => useCodeIntelligenceStore.getState().navigateForward()
      },
      {
        key: 'Mod-]',
        run: () => useCodeIntelligenceStore.getState().navigateForward()
      }
    ])
  )

  return [navKeymap, createCtrlHoverAndClickPlugin(getContext)]
}
