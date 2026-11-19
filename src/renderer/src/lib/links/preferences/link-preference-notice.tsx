import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { BROWSER_OPEN_LINKS_SETTINGS_TARGET_ID } from '@/components/settings/navigation/settings-navigation-types'
import { INLINE_ACTION_CLASS_NAMES } from '@/components/ui/sonner'

const LINK_PREFERENCE_NOTICE_ID = 'link-preference-notice'
const LINK_PREFERENCE_NOTICE_DURATION_MS = 9_000

export type LinkPreferenceNoticeKind =
  | { kind: 'saved'; openLinksInApp: boolean }
  | { kind: 'failed' }
  | { kind: 'unknown' }

export function openLinkSettings(): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsPage()
  openSettingsTarget({ pane: 'browser', repoId: null, sectionId: BROWSER_OPEN_LINKS_SETTINGS_TARGET_ID })
}

function noticeTitle(notice: LinkPreferenceNoticeKind): string {
  if (notice.kind === 'saved') {
    return notice.openLinksInApp
      ? translate('components.link.preferences.savedOrca', 'Links will open in the Orca browser')
      : translate('components.link.preferences.savedSystem', 'Links will open in your system browser')
  }
  return notice.kind === 'failed'
    ? translate('components.link.preferences.saveFailed', "Couldn't save your choice.")
    : translate('components.link.preferences.saveUnknown', "Couldn't confirm your choice was saved.")
}

/** One notice slot; showing replaces the previous notice and its timer. */
export function showLinkPreferenceNotice(notice: LinkPreferenceNoticeKind): void {
  const title = noticeTitle(notice)
  const show = (duration: number): void => {
    toast(title, {
      id: LINK_PREFERENCE_NOTICE_ID,
      duration,
      classNames: INLINE_ACTION_CLASS_NAMES,
      action: (
        <Button
          size="sm"
          variant="outline"
          // Sonner pauses on hover only; keyboard focus re-shows without a deadline until focus leaves.
          onFocus={() => show(Number.POSITIVE_INFINITY)}
          onBlur={() => show(LINK_PREFERENCE_NOTICE_DURATION_MS)}
          onClick={() => {
            toast.dismiss(LINK_PREFERENCE_NOTICE_ID)
            openLinkSettings()
          }}
        >
          {translate('components.link.preferences.settings', 'Settings')}
        </Button>
      )
    })
  }
  show(LINK_PREFERENCE_NOTICE_DURATION_MS)
}

export function dismissLinkPreferenceNotice(): void {
  toast.dismiss(LINK_PREFERENCE_NOTICE_ID)
}
