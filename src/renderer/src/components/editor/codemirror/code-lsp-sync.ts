import type { Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView } from '@codemirror/view'
import { setDiagnostics, type Diagnostic as LintDiagnostic } from '@codemirror/lint'
import type { CodeDiagnostic } from '@/store/code-intelligence/code-intelligence-types'
import {
  installCodeLspEventListeners,
  registerLiveCodeBufferReader,
  useCodeIntelligenceStore
} from '@/store/code-intelligence/use-code-intelligence-store'
import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'

const DID_CHANGE_DEBOUNCE_MS = 250

function lineColToClampedOffset(view: EditorView, line1: number, col1: number): number {
  const doc = view.state.doc
  const clampedLine = Math.min(Math.max(1, line1), doc.lines)
  const line = doc.line(clampedLine)
  const offset = Math.min(line.from + Math.max(0, col1 - 1), line.to)
  return Math.max(0, Math.min(offset, doc.length))
}

function toLintDiagnostics(view: EditorView, items: readonly CodeDiagnostic[]): LintDiagnostic[] {
  const docLen = view.state.doc.length
  return items.map((d) => {
    let from = lineColToClampedOffset(view, d.line, d.column)
    let to = lineColToClampedOffset(view, d.endLine, d.endColumn)
    if (to < from) {
      to = from
    }
    if (from === to && docLen > 0) {
      if (to < view.state.doc.lineAt(from).to) {
        to += 1
      } else if (from > view.state.doc.lineAt(from).from) {
        from -= 1
      }
    }
    const sourcePrefix = d.source ? `[${d.source}${d.code ? ` ${d.code}` : ''}] ` : ''
    return {
      from,
      to,
      severity: d.severity,
      message: `${sourcePrefix}${d.message}`,
      markClass: d.deprecated
        ? 'cm-lsp-deprecated'
        : d.unnecessary
          ? 'cm-lsp-unnecessary'
          : undefined
    }
  })
}

export function notifyLspDidSave(filePath: string, text: string): void {
  if (!isTauriNativeHost()) {
    return
  }
  void invokeNative('poc_lsp_did_save', { filePath, text }).catch(() => {})
}

export type CodeLspSyncParams = {
  filePath: string
  fileKey: string
  workspaceRoot: string | null
  language: string
}

export function createCodeLspSyncExtension(params: CodeLspSyncParams): Extension {
  installCodeLspEventListeners()

  return ViewPlugin.define((view: EditorView) => {
    const { filePath, fileKey, workspaceRoot, language } = params
    const unregisterBuffer = registerLiveCodeBufferReader(fileKey, () => view.state.doc.toString())
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    if (isTauriNativeHost()) {
      void invokeNative('poc_lsp_did_open', {
        filePath,
        workspaceRoot,
        language,
        text: view.state.doc.toString()
      }).catch(() => {})
    }

    const pushCurrentDiagnostics = (items: readonly CodeDiagnostic[]): void => {
      if (disposed || !view.dom.isConnected) {
        return
      }
      const lintDiags = toLintDiagnostics(view, items)
      requestAnimationFrame(() => {
        if (!disposed && view.dom.isConnected) {
          view.dispatch(setDiagnostics(view.state, lintDiags))
        }
      })
    }

    const initial = useCodeIntelligenceStore.getState().diagnosticsByFile[fileKey]
    if (initial && initial.length > 0) {
      pushCurrentDiagnostics(initial)
    }

    const unsubDiagnostics = useCodeIntelligenceStore.subscribe((state, prev) => {
      if (state.diagnosticsByFile[fileKey] !== prev.diagnosticsByFile[fileKey]) {
        pushCurrentDiagnostics(state.diagnosticsByFile[fileKey] ?? [])
      }
    })

    return {
      update(update) {
        if (!update.docChanged || !isTauriNativeHost()) {
          return
        }
        if (timer !== null) {
          clearTimeout(timer)
        }
        timer = setTimeout(() => {
          timer = null
          if (!disposed && view.dom.isConnected) {
            void invokeNative('poc_lsp_did_change', {
              filePath,
              workspaceRoot,
              language,
              text: view.state.doc.toString()
            }).catch(() => {})
          }
        }, DID_CHANGE_DEBOUNCE_MS)
      },
      destroy() {
        disposed = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        unregisterBuffer()
        unsubDiagnostics()
        if (isTauriNativeHost()) {
          void invokeNative('poc_lsp_did_close', { filePath }).catch(() => {})
        }
      }
    }
  })
}
