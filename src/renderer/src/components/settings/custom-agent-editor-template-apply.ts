// Caret-preserving template placeholder insertion for the custom-agent editor.
// Extracted from the controller hook so it stays under the module line budget;
// it mutates the draft immutably and restores the caret after React re-renders.

import { spliceTemplateValue, type TemplateInsertTarget } from './custom-agent-template-insert'
import type { CustomAgentEditorDraft } from './custom-agent-editor-state'

export function applyTemplateInsert(args: {
  target: TemplateInsertTarget
  selection: { start: number; end: number }
  placeholder: string
  element: HTMLTextAreaElement | HTMLInputElement
  setDraft: (updater: (current: CustomAgentEditorDraft) => CustomAgentEditorDraft) => void
}): void {
  const { target, selection, placeholder, element, setDraft } = args
  setDraft((current) => {
    if (target.kind === 'commandOverride') {
      const next = spliceTemplateValue(current.commandOverride, selection, placeholder)
      restoreCaret(element, next.caret)
      return { ...current, commandOverride: next.value }
    }
    if (target.kind === 'env') {
      const rows = current.envRows.map((row) => {
        if (row.rowId !== target.rowId) {
          return row
        }
        const next = spliceTemplateValue(row.value, selection, placeholder)
        restoreCaret(element, next.caret)
        return { ...row, value: next.value }
      })
      return { ...current, envRows: rows }
    }
    const next = spliceTemplateValue(current.args, selection, placeholder)
    restoreCaret(element, next.caret)
    return { ...current, args: next.value }
  })
}

function restoreCaret(element: HTMLTextAreaElement | HTMLInputElement, caret: number): void {
  requestAnimationFrame(() => {
    element.focus()
    element.setSelectionRange(caret, caret)
  })
}
