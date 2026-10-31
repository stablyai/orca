import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import type { EditorToggleValue } from './EditorViewToggle'

type MarkdownPreviewTarget = Pick<OpenFile, 'mode' | 'diffSource'> & {
  language: string
}

const MARKDOWN_EDIT_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const MARKDOWN_DIFF_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const MERMAID_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const CSV_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const NOTEBOOK_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const NO_VIEW_MODES = [] as const satisfies readonly MarkdownViewMode[]

// Expose Changes alongside language modes in one control; diff/conflict tabs already provide review surfaces.
const CODE_EDIT_TOGGLE_MODES = ['edit', 'changes'] as const satisfies readonly EditorToggleValue[]

export function getEditorToggleModes(target: MarkdownPreviewTarget): readonly EditorToggleValue[] {
  if (target.mode !== 'edit') {
    return getMarkdownViewModes(target)
  }
  if (target.language === 'notebook') {
    // Notebook source/Changes would expose raw JSON and fails for restored external notebooks.
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
      target.diffSource !== 'combined-all' &&
      target.diffSource !== 'combined-uncommitted' &&
      target.diffSource !== 'combined-branch' &&
      target.diffSource !== 'combined-commit'
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
  if (target.language === 'markdown' && target.mode === 'diff') {
    return 'source'
  }
  const modes = getMarkdownViewModes(target)
  return modes.includes('rich') ? 'rich' : 'source'
}

export function canOpenMarkdownPreview(target: MarkdownPreviewTarget): boolean {
  return target.language === 'markdown' && target.mode === 'edit'
}

export function isMarkdownPreviewShortcut(
  event: KeyboardEvent,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  return keybindingMatchesAction('editor.markdownPreview', event, platform, keybindings)
}
