import type { SettingsSearchEntry } from '../search/settings-search'
import type { GeneralSubPage } from './general-sub-pages'

export const GENERAL_SETTING_ANCHORS = {
  folder: 'general-workspace-folder',
  nesting: 'general-workspace-nesting',
  worktrees: 'general-global-worktree-visibility',
  openIn: 'general-open-in-apps',
  autoSave: 'general-auto-save',
  autoSaveDelay: 'general-editor-auto-save-delay',
  formatOnSave: 'general-editor-format-on-save',
  finalNewline: 'general-editor-final-newline',
  fontFamily: 'general-editor-font-family',
  fontSize: 'general-editor-font-size',
  fontWeight: 'general-editor-font-weight',
  lineHeight: 'general-editor-line-height',
  ligatures: 'general-editor-ligatures',
  fontSmoothing: 'general-editor-font-smoothing',
  editorWrap: 'general-editor-word-wrap',
  minimap: 'general-editor-minimap',
  diffView: 'general-editor-diff-view',
  diffWhitespace: 'general-editor-diff-whitespace',
  collapseUnchanged: 'general-editor-collapse-unchanged',
  diffWrap: 'general-editor-diff-wrap',
  diffTree: 'general-editor-diff-tree',
  markdownView: 'general-editor-markdown-view',
  spellcheck: 'general-editor-spellcheck',
  reviewNotes: 'general-editor-review-notes'
} as const

export type GeneralSearchDescriptor = {
  sectionId: string
  page: GeneralSubPage | null
  entry: SettingsSearchEntry
}

export function generalSetting(
  sectionId: string,
  page: GeneralSubPage | null,
  entry: SettingsSearchEntry
): GeneralSearchDescriptor {
  return { sectionId, page, entry }
}
