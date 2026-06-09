import { translate } from '@/i18n/i18n'

// Why: the GitPane toggle and the stale-local-main toast both reference this
// setting's title and deep-link anchor, so they share one source of truth
// rather than drifting string literals across modules.
export function getKeepLocalMainUpToDateTitle(): string {
  return translate(
    'auto.components.settings.keep.local.main.up.to.date.setting.f8bda25f29',
    'Keep Local Main Up to Date'
  )
}

export const KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID = 'git-keep-local-main-up-to-date'
