import { GENERAL_SETTING_OWNERS } from './general-setting-anchors'
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

export function resolveGeneralSubPage(sectionId?: string): GeneralSubPage | null {
  return sectionId ? (GENERAL_SETTING_OWNERS[sectionId] ?? null) : null
}
