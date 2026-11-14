import type { SettingsSearchEntry } from '../search/settings-search'
import type { GeneralSubPage } from './general-sub-pages'

export const GENERAL_SETTING_ANCHORS = {
  folder: 'general-workspace-folder',
  nesting: 'general-workspace-nesting',
  worktrees: 'general-global-worktree-visibility',
  openIn: 'general-open-in-apps',
  cliSkill: 'general-cli-skill',
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
  gitChangeGutter: 'general-editor-git-change-gutter',
  diffView: 'general-editor-diff-view',
  diffWhitespace: 'general-editor-diff-whitespace',
  collapseUnchanged: 'general-editor-collapse-unchanged',
  diffWrap: 'general-editor-diff-wrap',
  diffTree: 'general-editor-diff-tree',
  markdownView: 'general-editor-markdown-view',
  spellcheck: 'general-editor-spellcheck',
  reviewNotes: 'general-editor-review-notes'
} as const

// A search result for a General sub-page opens that page at this row.
export const GENERAL_SUB_PAGE_ENTRY_ANCHORS: readonly (readonly [GeneralSubPage, string])[] = [
  ['folder', GENERAL_SETTING_ANCHORS.folder],
  ['worktrees', GENERAL_SETTING_ANCHORS.worktrees],
  ['open-in', GENERAL_SETTING_ANCHORS.openIn],
  ['editor', GENERAL_SETTING_ANCHORS.autoSaveDelay]
]

export const GENERAL_SETTING_OWNERS: Readonly<Record<string, GeneralSubPage | null>> = {
  [GENERAL_SETTING_ANCHORS.folder]: 'folder',
  [GENERAL_SETTING_ANCHORS.nesting]: 'folder',
  [GENERAL_SETTING_ANCHORS.worktrees]: 'worktrees',
  [GENERAL_SETTING_ANCHORS.openIn]: 'open-in',
  [GENERAL_SETTING_ANCHORS.autoSave]: null,
  [GENERAL_SETTING_ANCHORS.autoSaveDelay]: 'editor',
  [GENERAL_SETTING_ANCHORS.formatOnSave]: 'editor',
  [GENERAL_SETTING_ANCHORS.finalNewline]: 'editor',
  [GENERAL_SETTING_ANCHORS.fontFamily]: 'editor',
  [GENERAL_SETTING_ANCHORS.fontSize]: 'editor',
  [GENERAL_SETTING_ANCHORS.fontWeight]: 'editor',
  [GENERAL_SETTING_ANCHORS.lineHeight]: 'editor',
  [GENERAL_SETTING_ANCHORS.ligatures]: 'editor',
  [GENERAL_SETTING_ANCHORS.fontSmoothing]: 'editor',
  [GENERAL_SETTING_ANCHORS.editorWrap]: 'editor',
  [GENERAL_SETTING_ANCHORS.minimap]: 'editor',
  [GENERAL_SETTING_ANCHORS.gitChangeGutter]: 'editor',
  [GENERAL_SETTING_ANCHORS.diffView]: 'editor',
  [GENERAL_SETTING_ANCHORS.diffWhitespace]: 'editor',
  [GENERAL_SETTING_ANCHORS.collapseUnchanged]: 'editor',
  [GENERAL_SETTING_ANCHORS.diffWrap]: 'editor',
  [GENERAL_SETTING_ANCHORS.diffTree]: 'editor',
  [GENERAL_SETTING_ANCHORS.markdownView]: 'editor',
  [GENERAL_SETTING_ANCHORS.spellcheck]: 'editor',
  [GENERAL_SETTING_ANCHORS.reviewNotes]: 'editor',
  'general-editor-settings': 'editor'
}

export type GeneralSearchDescriptor = {
  sectionId: string
  page: GeneralSubPage | null
  entry: SettingsSearchEntry
}

export function generalSetting(
  sectionId: string,
  entry: SettingsSearchEntry
): GeneralSearchDescriptor {
  return { sectionId, page: GENERAL_SETTING_OWNERS[sectionId] ?? null, entry }
}
