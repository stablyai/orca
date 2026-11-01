import { translate } from '@/i18n/i18n'

// Share title/deep-link copy between GitPane and stale-main toasts to prevent drift.
export function getKeepLocalMainUpToDateTitle(): string {
  return translate(
    'auto.components.settings.keep.local.main.up.to.date.setting.f8bda25f29',
    'Keep Local Main Up to Date'
  )
}

export const KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID = 'git-keep-local-main-up-to-date'
