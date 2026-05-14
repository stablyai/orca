import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import type { EditorToggleValue } from './EditorViewToggle'

type MarkdownPreviewTarget = Pick<OpenFile, 'mode' | 'diffSource'> & {
  language: string
}

const MARKDOWN_EDIT_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const MARKDOWN_DIFF_VIEW_MODES = [
  'source',
  'preview'
] as const satisfies readonly MarkdownViewMode[]
const MERMAID_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const CSV_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const NOTEBOOK_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const NO_VIEW_MODES = [] as const satisfies readonly MarkdownViewMode[]

// Why: every editable file (markdown, mermaid, or plain code) can flip into
// Changes view mode. The toggle surfaces this alongside any language-specific
// modes so there is one UI control per pane, not two. Non-edit tabs (diff,
// conflict) do NOT get Changes because they are already a diff/review surface.
// Plain code files have no markdown-style sub-modes, so their toggle is just
// Edit | Changes.
const CODE_EDIT_TOGGLE_MODES = ['edit', 'changes'] as const satisfies readonly EditorToggleValue[]

export function getEditorToggleModes(target: MarkdownPreviewTarget): readonly EditorToggleValue[] {
  if (target.mode !== 'edit') {
    return getMarkdownViewModes(target)
  }
  if (target.language === 'notebook') {
    // Why: notebook source mode is raw JSON and Changes would diff that JSON,
    // which is noisy and currently invalid for restored external notebooks.
    return NOTEBOOK_VIEW_MODES
  }
  const languageModes = getMarkdownViewModes(target)
  if (languageModes.length > 0) {
    return [...languageModes, 'changes']
  }
  return CODE_EDIT_TOGGLE_MODES
}

export function getMarkdownViewModes(target: MarkdownPreviewTarget): readonly MarkdownViewMode[] {
  if (target.language === 'markdown') {
    if (target.mode === 'edit') {
      return MARKDOWN_EDIT_VIEW_MODES
    }
    if (
      target.mode === 'diff' &&
      target.diffSource !== 'combined-uncommitted' &&
      target.diffSource !== 'combined-branch'
    ) {
      return MARKDOWN_DIFF_VIEW_MODES
    }
  }

  if (target.language === 'mermaid' && target.mode === 'edit') {
    return MERMAID_VIEW_MODES
  }

  if ((target.language === 'csv' || target.language === 'tsv') && target.mode === 'edit') {
    return CSV_VIEW_MODES
  }

  if (target.language === 'notebook' && target.mode === 'edit') {
    return NOTEBOOK_VIEW_MODES
  }

  return NO_VIEW_MODES
}

export function getDefaultMarkdownViewMode(target: MarkdownPreviewTarget): MarkdownViewMode {
  const modes = getMarkdownViewModes(target)
  return modes.includes('rich') ? 'rich' : 'source'
}

export function canOpenMarkdownPreview(target: MarkdownPreviewTarget): boolean {
  return target.language === 'markdown' && target.mode === 'edit'
}

export function isMarkdownPreviewShortcut(event: KeyboardEvent, isMac: boolean): boolean {
  const modifierPressed = isMac ? event.metaKey : event.ctrlKey
  return modifierPressed && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v'
}

export function getMarkdownPreviewShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘⇧V' : 'Ctrl+Shift+V'
}
