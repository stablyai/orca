import { Laptop } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'

/** The host has no guest for a page deliberately rendered on another desktop; show that placement rather than a failure. */
export function ClientHostedBrowserHostRowPane({
  row
}: {
  row: ClientHostedBrowserRow
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Laptop className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {row.hostAbsent
            ? t('browser.clientHosted.hostPaneOfflineTitle', 'That device is no longer connected')
            : row.hostDeviceName
              ? t('browser.clientHosted.hostPaneNamedTitle', 'Showing on {{device}}', {
                  device: row.hostDeviceName
                })
              : t('browser.clientHosted.hostPaneTitle', 'Showing on another device')}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">
          {row.hostAbsent
            ? t(
                'browser.clientHosted.hostPaneOfflineDescription',
                'This page stays listed so you can close it from here. It will come back when the device reconnects.'
              )
            : t(
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
