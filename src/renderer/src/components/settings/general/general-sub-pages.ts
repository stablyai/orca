import { GENERAL_SETTING_ANCHORS } from './general-setting-anchors'
import type { Translate } from '@/i18n/use-translate'

export type GeneralSubPage = 'folder' | 'worktrees' | 'open-in' | 'editor'

export function getGeneralSubPageTitle(page: GeneralSubPage, t: Translate): string {
  switch (page) {
    case 'folder':
      return t('settings.general.pages.folder', 'Workspace folder')
    case 'worktrees':
      return t('settings.general.pages.worktrees', 'Worktrees from other tools')
    case 'open-in':
      return t('settings.general.pages.openIn', 'Open in')
    case 'editor':
      return t('settings.general.pages.editor', 'Editor and diffs')
  }
}

const GENERAL_SUB_PAGE_BY_SECTION: Readonly<Record<string, GeneralSubPage>> = {
  [GENERAL_SETTING_ANCHORS.folder]: 'folder',
  [GENERAL_SETTING_ANCHORS.nesting]: 'folder',
  [GENERAL_SETTING_ANCHORS.worktrees]: 'worktrees',
  [GENERAL_SETTING_ANCHORS.openIn]: 'open-in',
  'general-editor-settings': 'editor',
  ...Object.fromEntries(
    Object.values(GENERAL_SETTING_ANCHORS)
      .filter((id) => id.startsWith('general-editor-'))
      .map((id) => [id, 'editor' as const])
  )
}

export function resolveGeneralSubPage(sectionId?: string): GeneralSubPage | null {
  return sectionId ? (GENERAL_SUB_PAGE_BY_SECTION[sectionId] ?? null) : null
}
