// GH-LIST-MISSING: when GitHub's list couldn't be read, the Project picker's GitHub section says so
// with Retry instead of disappearing, which read as "no repositories".
import React from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/** Nothing while the list reads fine (or Orca Cloud isn't picked): `onRetry` is null then. */
export function ProjectComboboxCloudUnavailable({
  onRetry
}: {
  onRetry: (() => void) | null
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!onRetry) {
    return null
  }
  const heading = t('components.newWorkspace.cloudOnly.headingShort', 'GitHub')
  return (
    <div role="group" aria-label={heading} data-cloud-repos-unavailable>
      <div
        aria-hidden="true"
        className="px-2 pt-2.5 pb-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase"
      >
        {heading}
      </div>
      <div className="flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground">
        <span role="status">
          {t(
            'components.newWorkspace.cloudOnly.reposUnavailable',
            'Couldn’t load GitHub repositories.'
          )}
        </span>
        <Button
          type="button"
          variant="link"
          size="statusAction"
          // Keep focus in the search field, as the rows do.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRetry}
        >
          <RefreshCw className="size-3" aria-hidden />
          <span className="underline underline-offset-4">
            {t('components.newWorkspace.cloudOnly.retryRepos', 'Retry')}
          </span>
        </Button>
      </div>
    </div>
  )
}
