import React, { useEffect, useRef, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { AutomationHostStatusBadges } from './AutomationHostBadges'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'
import {
  automationHostRecoveryActions,
  recoveryActionLabel,
  type AutomationHostRecoveryAction
} from './automation-host-status-descriptors'

/**
 * Inline status for the current host selection, plus the two polite
 * announcements. Status appears inline rather than as a toast because the user
 * has to read and act on it, and it must never steal focus.
 */

export function automationHostLoadSummaryMessage(
  failedHostCount: number,
  totalHostCount: number
): string | null {
  if (failedHostCount <= 0) {
    return null
  }
  return translate(
    'auto.components.automations.hostSummary.partialFailure',
    '{{failed}} of {{total}} hosts could not be loaded',
    { failed: failedHostCount, total: totalHostCount }
  )
}

type AutomationHostLoadSummaryProps = {
  failedHostCount: number
  totalHostCount: number
  className?: string
}

/** Polite and deduplicated: re-announces only when the failed count changes, not per retry. */
export function AutomationHostLoadSummary({
  failedHostCount,
  totalHostCount,
  className
}: AutomationHostLoadSummaryProps): React.JSX.Element {
  const [announced, setAnnounced] = useState<string>('')
  // Why a ref: a host joining or leaving must not re-announce an unchanged set of failures.
  const totalRef = useRef(totalHostCount)
  totalRef.current = totalHostCount

  useEffect(() => {
    setAnnounced(automationHostLoadSummaryMessage(failedHostCount, totalRef.current) ?? '')
  }, [failedHostCount])

  return (
    <div role="status" aria-live="polite" className={cn('sr-only', className)}>
      {announced}
    </div>
  )
}

type AutomationHostFilterNoticeProps = {
  resolution: AutomationHostFilterResolution
  onRecover?: (action: AutomationHostRecoveryAction) => void
  className?: string
}

function noticeCopy(resolution: AutomationHostFilterResolution): string | null {
  const label =
    resolution.entry?.label ??
    translate('auto.components.automations.emptyState.unknownHost', 'this host')
  switch (resolution.status) {
    case 'loading':
      return translate('auto.components.automations.hostNotice.loading', 'Loading host…')
    case 'unavailable':
      return translate(
        'auto.components.automations.hostNotice.unavailable',
        '{{hostLabel}} could not be reached. Showing the automations last loaded from it.',
        { hostLabel: label }
      )
    case 'ghost':
      return translate(
        'auto.components.automations.hostNotice.ghost',
        '{{hostLabel}} was removed. Automations still assigned to it remain listed.',
        { hostLabel: label }
      )
    case 'removed':
      return translate(
        'auto.components.automations.hostNotice.removed',
        'The selected host is no longer available. Showing all hosts.'
      )
    case 'all':
    case 'ready':
      return null
  }
}

export function AutomationHostFilterNotice({
  resolution,
  onRecover,
  className
}: AutomationHostFilterNoticeProps): React.JSX.Element {
  const [announcedFallback, setAnnouncedFallback] = useState<string>('')
  const message = noticeCopy(resolution)
  const recovery = resolution.entry ? automationHostRecoveryActions(resolution.entry) : null
  const action = recovery?.authority ?? recovery?.execution ?? null
  const isLoading = resolution.status === 'loading'

  useEffect(() => {
    setAnnouncedFallback(
      resolution.announceFallback
        ? translate(
            'auto.components.automations.hostNotice.removed',
            'The selected host is no longer available. Showing all hosts.'
          )
        : ''
    )
  }, [resolution.announceFallback])

  return (
    <>
      {/* Outlives every notice state: a region inserted with its text already in it is announced by nothing. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcedFallback}
      </div>
      {message ? (
        <div
          data-filter-status={resolution.status}
          className={cn(
            'flex flex-wrap items-center gap-2 rounded-lg px-3.5 py-2.5 text-xs',
            isLoading
              ? 'border border-border bg-muted/40 text-muted-foreground'
              : 'border border-amber-500/40 bg-amber-500/10 text-foreground dark:border-amber-500/35 dark:bg-amber-500/15',
            className
          )}
        >
          {isLoading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <span className="min-w-0 flex-1 leading-normal font-medium">{message}</span>
          {resolution.entry ? <AutomationHostStatusBadges entry={resolution.entry} /> : null}
          {action && onRecover ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="border-amber-500/40 bg-background font-medium text-foreground shadow-xs hover:bg-muted"
              onClick={() => onRecover(action)}
            >
              {recoveryActionLabel(action)}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
