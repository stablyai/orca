import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'

type MarkdownPreviewTarget = Pick<OpenFile, 'mode' | 'diffSource'> & {
  language: string
}

const MARKDOWN_EDIT_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const MARKDOWN_DIFF_VIEW_MODES = [
  'source',
  'preview'
] as const satisfies readonly MarkdownViewMode[]
const MERMAID_VIEW_MODES = ['source', 'rich'] as const satisfies readonly MarkdownViewMode[]
const NO_VIEW_MODES = [] as const satisfies readonly MarkdownViewMode[]

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
