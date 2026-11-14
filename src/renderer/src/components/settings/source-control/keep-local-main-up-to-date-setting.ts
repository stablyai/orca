import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

// Share title/deep-link copy between GitPane and stale-main toasts to prevent drift.
export function getKeepLocalMainUpToDateTitle(t: Translate = translate): string {
  return t(
    'auto.components.settings.keep.local.main.up.to.date.setting.f4c23aee76',
    'Keep local main up to date'
  )
}

export const KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID = 'git-keep-local-main-up-to-date'
