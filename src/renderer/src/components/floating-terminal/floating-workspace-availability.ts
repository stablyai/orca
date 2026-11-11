import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { isWebClientLocation } from '../../app-shell/platform/web-client-location'

/** The floating workspace's terminals and notes live on this computer; a browser tab has none. */
export function floatingWorkspaceUnavailableReason(t: Translate = translate): string | null {
  return isWebClientLocation()
    ? t(
        'auto.lib.floating.workspace.availability.web',
        'The floating workspace runs on your own computer, so it is only available in the Orca desktop app.'
      )
    : null
}
