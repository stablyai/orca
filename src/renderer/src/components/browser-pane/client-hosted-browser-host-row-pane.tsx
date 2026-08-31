import { Laptop } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'

/**
 * What the HOST sees when it selects a page rendering on a paired client. The mirror image of
 * ClientHostedBrowserUnavailableNotice, which is what the CLIENT shows for a page it cannot reach:
 * same visual language, opposite point of view. There is no guest to show here and never will be —
 * the page is on the other desktop by design, not by failure.
 */
export function ClientHostedBrowserHostRowPane({
  row
}: {
  row: ClientHostedBrowserRow
}): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Laptop className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {row.hostAbsent
            ? translate(
                'browser.clientHosted.hostPaneOfflineTitle',
                'That device is no longer connected'
              )
            : row.hostDeviceName
              ? translate('browser.clientHosted.hostPaneNamedTitle', 'Showing on {{device}}', {
                  device: row.hostDeviceName
                })
              : translate('browser.clientHosted.hostPaneTitle', 'Showing on another device')}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">
          {row.hostAbsent
            ? translate(
                'browser.clientHosted.hostPaneOfflineDescription',
                'This page stays listed so you can close it from here. It will come back when the device reconnects.'
              )
            : translate(
                'browser.clientHosted.hostPaneDescription',
                'This page renders on the paired desktop that opened it.'
              )}
        </div>
        <div className="max-w-full truncate text-xs text-muted-foreground/80" title={row.url}>
          {row.url}
        </div>
      </div>
    </div>
  )
}
