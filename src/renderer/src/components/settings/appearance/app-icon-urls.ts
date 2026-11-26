import classicIconUrl from '../../../../../../resources/icon.png?url'
import watercolorIconUrl from '../../../../../../resources/app-icons/orca-watercolor.png?url'
import blueIconUrl from '../../../../../../resources/app-icons/orca-blue.png?url'
import {
  CUSTOM_APP_ICON_ID,
  DEFAULT_APP_ICON_ID,
  normalizeAppIconId,
  type BuiltInAppIconId
} from '../../../../../shared/app-lifecycle/identity/app-icon'

export const APP_ICON_URLS = {
  classic: classicIconUrl,
  watercolor: watercolorIconUrl,
  blue: blueIconUrl
} satisfies Record<BuiltInAppIconId, string>

/** The built-in icon the app shows; a custom icon falls back to Classic, as main does when its file is gone. */
export function getBuiltInAppIconUrl(value: unknown): string {
  const id = normalizeAppIconId(value)
  return APP_ICON_URLS[id === CUSTOM_APP_ICON_ID ? DEFAULT_APP_ICON_ID : id]
}
