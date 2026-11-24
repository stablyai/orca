import { StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  ViewPlugin,
  showTooltip,
  type EditorView,
  type Tooltip,
  type ViewUpdate
} from '@codemirror/view'
import type { CodeSignatureHelp } from '@/store/code-intelligence/code-intelligence-types'
import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import type { CodeIntelligenceContext } from './code-intelligence-extension'
import { posToLineCol } from './code-navigation-actions'

const setSignatureEffect = StateEffect.define<{ pos: number; help: CodeSignatureHelp } | null>()

function buildSignatureDom(help: CodeSignatureHelp): HTMLElement {
  const sigIdx = Math.min(Math.max(0, help.activeSignature), help.signatures.length - 1)
  const sig = help.signatures[sigIdx]
  const dom = document.createElement('div')
  dom.className = 'cm-lsp-signature'

  const labelEl = document.createElement('div')
  labelEl.className = 'cm-lsp-signature-label'
  const activeParam = sig.parameters[help.activeParameter]
  if (activeParam) {
    const matchIdx = sig.label.indexOf(activeParam)
    if (matchIdx !== -1) {
      labelEl.append(document.createTextNode(sig.label.slice(0, matchIdx)))
      const strong = document.createElement('span')
      strong.className = 'cm-lsp-signature-active'
      strong.textContent = activeParam
      labelEl.append(
        strong,
        document.createTextNode(sig.label.slice(matchIdx + activeParam.length))
      )
    } else {
      labelEl.textContent = sig.label
    }
  } else {
    labelEl.textContent = sig.label
  }
  dom.append(labelEl)

  if (sig.documentation) {
    const docEl = document.createElement('div')
    docEl.className = 'cm-lsp-hover-text'
    docEl.textContent = sig.documentation
    dom.append(docEl)
  }
  return dom
}

const signatureField = StateField.define<{ pos: number; help: CodeSignatureHelp } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSignatureEffect)) {
        return e.value
      }
    }
    return value
  },
  provide: (field) =>
    showTooltip.from(field, (val): Tooltip | null => {
      if (!val || val.help.signatures.length === 0) {
        return null
      }
      return {
        pos: val.pos,
        above: true,
        create: () => ({ dom: buildSignatureDom(val.help) })
      }
    })
})

export function createCodeSignatureHelpExtension(
  getContext: () => CodeIntelligenceContext
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null
      requestSeq = 0

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (!isTauriNativeHost()) {
          return
        }
        const cur = update.state.field(signatureField, false) ?? null
        let typedTrigger = false
        let closedParen = false
        if (update.docChanged) {
          update.changes.iterChanges((_fA, _tA, _fB, _tB, inserted) => {
            const txt = inserted.toString()
            if (txt.includes('(') || txt.includes(',')) {
              typedTrigger = true
            }
            if (txt.includes(')')) {
              closedParen = true
            }
          })
        }
        if (closedParen) {
          this.clearTooltip()
          return
        }
        if (update.selectionSet && cur) {
          const curLine = update.state.doc.lineAt(cur.pos).number
          const headLine = update.state.doc.lineAt(update.state.selection.main.head).number
          if (curLine !== headLine) {
            this.clearTooltip()
            return
          }
        }
        if (!typedTrigger && !(update.selectionSet && cur)) {
          return
        }
        if (this.timer) {
          clearTimeout(this.timer)
        }
        const seq = ++this.requestSeq
        const pos = update.state.selection.main.head
        this.timer = setTimeout(() => {
          this.timer = null
          const ctx = getContext()
          const { line, column } = posToLineCol(this.view.state.doc, pos)
          void invokeNative<CodeSignatureHelp | null>('poc_lsp_signature_help', {
            filePath: ctx.filePath,
            workspaceRoot: ctx.workspaceRoot,
            language: ctx.language,
            line,
            column,
            text: this.view.state.doc.toString()
          })
            .then((help) => {
              if (seq !== this.requestSeq || !this.view.dom.isConnected) {
                return
              }
              this.view.dispatch({
                effects: setSignatureEffect.of(
                  help && help.signatures.length > 0 ? { pos, help } : null
                )
              })
            })
            .catch(() => {})
        }, 120)
      }

      clearTooltip(): void {
        this.requestSeq += 1
        if (this.timer) {
          clearTimeout(this.timer)
          this.timer = null
        }
        if (this.view.state.field(signatureField, false)) {
          requestAnimationFrame(() => {
            if (this.view.dom.isConnected) {
              this.view.dispatch({ effects: setSignatureEffect.of(null) })
            }
          })
        }
      }

      destroy(): void {
        if (this.timer) {
          clearTimeout(this.timer)
          this.timer = null
        }
      }
    }
  )

  return [signatureField, plugin]
}
