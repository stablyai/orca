// GH-LIST-MISSING: when GitHub's list couldn't be read, the Project picker's GitHub section says so
// with Retry instead of disappearing, which read as "no repositories". Retry is a row like the
// others: the arrow keys land on it and Enter runs it (design-squad).
import React from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

export type CloudReposRetry = {
  retry: () => void
  /** Reading again now: shows Loading… and can't be pressed again. */
  retrying: boolean
}

/** Nothing while the list reads fine (or Orca Cloud isn't picked): `retry` is null then. */
export function ProjectComboboxCloudUnavailable({
  retry,
  armed,
  armedId,
  onArm,
  onCommit
}: {
  retry: CloudReposRetry | null
  armed: boolean
  armedId: string
  onArm: () => void
  onCommit: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!retry) {
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
      <p role="status" className="px-2 pb-1 text-xs text-muted-foreground">
        {t(
          'components.newWorkspace.cloudOnly.reposUnavailable',
          'Couldn’t load GitHub repositories.'
        )}
      </p>
      <div
        role="option"
        id={armed ? armedId : undefined}
        aria-selected={armed}
        aria-disabled={retry.retrying || undefined}
        data-armed={armed || undefined}
        // Keep focus in the search field, as the rows do.
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={onArm}
        onClick={onCommit}
        className={cn(
          'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground',
          armed && 'bg-accent text-accent-foreground'
        )}
      >
        {retry.retrying ? (
          <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <RefreshCw className="size-3.5" aria-hidden />
        )}
        {retry.retrying
          ? t('components.newWorkspace.cloudOnly.reposLoading', 'Loading…')
          : t('components.newWorkspace.cloudOnly.retryRepos', 'Retry')}
      </div>
    </div>
  )
}
