import type { Extension } from '@codemirror/state'
import { hoverTooltip, type EditorView } from '@codemirror/view'
import {
  completeAnyWord,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import type {
  CodeCompletionItem,
  CodeDiagnostic,
  CodeHover
} from '@/store/code-intelligence/code-intelligence-types'
import { useCodeIntelligenceStore } from '@/store/code-intelligence/use-code-intelligence-store'
import { useDebugSessionStore } from '@/store/debug/use-debug-session-store'
import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import { posToLineCol, wordAtPosition } from './code-navigation-actions'

let modifierPressed = false

if (typeof window !== 'undefined') {
  const syncModifier = (e: KeyboardEvent): void => {
    modifierPressed = e.altKey || e.ctrlKey || e.metaKey
  }
  window.addEventListener('keydown', syncModifier, true)
  window.addEventListener('keyup', syncModifier, true)
  window.addEventListener('blur', () => {
    modifierPressed = false
  })
}

export type CodeIntelligenceContext = {
  filePath: string
  fileKey: string
  workspaceRoot: string | null
  language: string
}

function findDiagnosticsAtPos(
  view: EditorView,
  items: readonly CodeDiagnostic[],
  pos: number
): CodeDiagnostic[] {
  const { line, column } = posToLineCol(view.state.doc, pos)
  return items.filter((d) => {
    if (line < d.line || line > d.endLine) {
      return false
    }
    if (line === d.line && column < d.column) {
      return false
    }
    if (line === d.endLine && column > Math.max(d.endColumn, d.column + 1)) {
      return false
    }
    return true
  })
}

function appendFormattedHoverContent(container: HTMLElement, markdown: string): void {
  const segments = markdown.split(/(```[\s\S]*?```)/g)
  for (const seg of segments) {
    const trimmed = seg.trim()
    if (!trimmed) {
      continue
    }
    if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
      const inner = trimmed.slice(3, -3)
      const firstNewline = inner.indexOf('\n')
      const codeBody = firstNewline !== -1 ? inner.slice(firstNewline + 1) : inner
      const pre = document.createElement('pre')
      pre.className = 'cm-lsp-hover-code'
      pre.textContent = codeBody.trimEnd()
      container.append(pre)
    } else {
      const p = document.createElement('div')
      p.className = 'cm-lsp-hover-text'
      p.textContent = trimmed
      container.append(p)
    }
  }
}

function buildHoverDom(diags: readonly CodeDiagnostic[], hover: CodeHover | null): HTMLElement {
  const root = document.createElement('div')
  root.className = 'cm-lsp-hover'

  for (const diag of diags) {
    const row = document.createElement('div')
    row.className = `cm-lsp-hover-diag cm-lsp-hover-diag-${diag.severity}`
    const badge = document.createElement('span')
    badge.className = 'cm-lsp-hover-diag-badge'
    badge.textContent = diag.severity.toUpperCase()
    const msg = document.createElement('span')
    msg.textContent = diag.source ? `[${diag.source}] ${diag.message}` : diag.message
    row.append(badge, msg)
    root.append(row)
  }

  if (hover?.markdown) {
    appendFormattedHoverContent(root, hover.markdown)
  }
  return root
}

export function createCodeIntelligenceExtension(
  getContext: () => CodeIntelligenceContext
): Extension {
  return hoverTooltip(
    async (view, pos) => {
      if (modifierPressed) {
        return null
      }
      if (useDebugSessionStore.getState().status === 'stopped') {
        return null
      }
      const ctx = getContext()
      const fileDiags = useCodeIntelligenceStore.getState().diagnosticsByFile[ctx.fileKey] ?? []
      const overlappingDiags = findDiagnosticsAtPos(view, fileDiags, pos)
      const word = wordAtPosition(view.state.doc, pos)

      let hover: CodeHover | null = null
      if (isTauriNativeHost() && (word || overlappingDiags.length > 0)) {
        const { line, column } = posToLineCol(view.state.doc, pos)
        hover = await invokeNative<CodeHover | null>('poc_lsp_hover', {
          filePath: ctx.filePath,
          workspaceRoot: ctx.workspaceRoot,
          language: ctx.language,
          line,
          column,
          text: view.state.doc.toString()
        }).catch(() => null)
      }

      if (modifierPressed || useDebugSessionStore.getState().status === 'stopped') {
        return null
      }
      if (overlappingDiags.length === 0 && !hover?.markdown) {
        return null
      }
      const from = word?.from ?? pos
      const to = word?.to ?? pos
      return {
        pos: from,
        end: to,
        above: true,
        create: () => ({ dom: buildHoverDom(overlappingDiags, hover) })
      }
    },
    { hoverTime: 280 }
  )
}

function mapLspKindToCmType(kind: string): string {
  if (kind === 'enumMember') {
    return 'enum'
  }
  if (kind === 'typeAlias' || kind === 'struct') {
    return 'type'
  }
  if (kind === 'module' || kind === 'file') {
    return 'namespace'
  }
  return kind
}

export function createCodeCompletionSource(
  getContext: () => CodeIntelligenceContext
): (context: CompletionContext) => Promise<CompletionResult | null> {
  return async (context) => {
    const word = context.matchBefore(/[\p{L}\p{N}_$]+/u)
    const triggerMatch = context.matchBefore(/[.:/]$/u)
    if (!context.explicit && !word && !triggerMatch) {
      return null
    }
    const ctx = getContext()
    if (isTauriNativeHost()) {
      const { line, column } = posToLineCol(context.state.doc, context.pos)
      const items = await invokeNative<CodeCompletionItem[]>('poc_lsp_completion', {
        filePath: ctx.filePath,
        workspaceRoot: ctx.workspaceRoot,
        language: ctx.language,
        line,
        column,
        triggerCharacter: triggerMatch ? triggerMatch.text : null,
        text: context.state.doc.toString()
      }).catch(() => [])

      if (items.length > 0) {
        const from = word ? word.from : context.pos
        const options: Completion[] = items.map((item) => ({
          label: item.label,
          type: mapLspKindToCmType(item.kind),
          detail: item.detail ?? undefined,
          apply: item.insertText ?? item.label,
          info: item.documentation
            ? () => {
                const dom = document.createElement('div')
                dom.className = 'cm-lsp-hover-text'
                dom.textContent = item.documentation ?? ''
                return dom
              }
            : undefined
        }))
        return { from, options, validFor: /^[\p{L}\p{N}_$]*$/u }
      }
    }
    return completeAnyWord(context)
  }
}
