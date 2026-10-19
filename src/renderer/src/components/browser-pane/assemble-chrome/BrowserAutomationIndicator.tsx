import type { ReactElement } from 'react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import {
  useBrowserAutomationActive,
  useBrowserAutomationActiveForAny
} from '@/lib/browser-automation-activity'

type Props = {
  browserPageId: string | null | undefined
}

export function BrowserAutomationIndicator({ browserPageId }: Props): ReactElement | null {
  const active = useBrowserAutomationActive(browserPageId)
  if (!active) {
    return null
  }

  return (
    <div
      data-browser-automation-page-id={browserPageId}
      className="pointer-events-none absolute inset-0 z-40"
    >
      <div aria-hidden="true" className="absolute inset-0 ring-2 ring-inset ring-ring" />
      <div
        className="absolute right-3 bottom-3"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Badge variant="secondary">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
          />
          {translate('browser.automation.active', 'Browser automation active')}
        </Badge>
      </div>
    </div>
  )
}

export function BrowserAutomationTabIndicator({
  browserPageIds
}: {
  browserPageIds: readonly (string | null | undefined)[]
}): ReactElement | null {
  const active = useBrowserAutomationActiveForAny(browserPageIds)
  if (!active) {
    return null
  }

  return (
    <span className="mr-1 flex shrink-0 items-center text-foreground">
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
      />
      <span className="sr-only">
        {translate('browser.automation.active', 'Browser automation active')}
      </span>
    </span>
  )
}
