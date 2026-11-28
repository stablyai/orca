import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openFailureDetail } from './workspace-browser-tab-presentation'

/** The toast for a failed browser open: its title, and its cause as one short line when known. */
export function showBrowserOpenFailure(error: unknown): void {
  toast.error(
    error instanceof Error
      ? error.message
      : translate('auto.lib.workspace.browser.tab.open.urlFailed', 'Unable to open URL.'),
    { description: openFailureDetail(error) ?? undefined }
  )
}
