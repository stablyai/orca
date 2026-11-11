import React from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import { wakeCloudWorkspace } from '../cloud-workspace-actions'

/** "3:10 PM" today; "Nov 10, 3:10 PM" once it has been asleep across a day boundary. */
export function formatAsleepSince(at: number, now = Date.now()): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return new Intl.DateTimeFormat(getIntlLocale(), {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(at))
}

/**
 * A terminal pane of an Orca Cloud workspace that is asleep (RA-12): nothing dropped and nothing to
 * retry, so a calm line and Wake instead of a reconnect toast. The pane keeps its scrollback
 * underneath, greyed out behind an "Asleep since" divider so old output (a dev server's "Serving
 * on port 8000") doesn't read as live (JA-15).
 */
export function CloudAsleepTerminalNotice({
  workspaceId,
  asleepSince,
  waking = false,
  historyEndPx = null
}: {
  workspaceId: string
  asleepSince: number | null
  /** Waking: the waking pill speaks; keep only the greyed history and its divider. */
  waking?: boolean
  /**
   * Where the pre-sleep output ends, in px from the top of the pane: the divider sits right under
   * the last line. Null when unknown or the history fills the pane (then it ends at the bottom).
   */
  historyEndPx?: number | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      data-cloud-asleep-terminal-notice=""
      className="pointer-events-none absolute inset-0 z-50 flex flex-col justify-end"
    >
      {/* Greys out the stale scrollback; the pane's text stays selectable through it. */}
      <div
        data-cloud-asleep-scrim=""
        aria-hidden="true"
        className="absolute inset-0 bg-background/55"
      />
      <div className="relative flex flex-col gap-2 px-3 pb-3">
        {asleepSince !== null ? (
          <div
            data-cloud-asleep-divider=""
            // Right under the last line of history, so it reads as the history's end, not a footer.
            style={historyEndPx !== null ? { top: historyEndPx } : undefined}
            className={
              historyEndPx !== null
                ? 'absolute inset-x-3 flex items-center gap-2 text-[11px] text-muted-foreground'
                : 'flex items-center gap-2 text-[11px] text-muted-foreground'
            }
          >
            <span className="h-px flex-1 bg-border" />
            <span>
              {t('orcaCloudWorkspace.terminal.asleepSince', 'Asleep since {{time}}', {
                time: formatAsleepSince(asleepSince)
              })}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}
        {waking ? null : (
          <div
            role="status"
            className="pointer-events-auto flex items-center justify-between gap-3 rounded-md border border-border bg-popover px-3.5 py-2.5 text-xs text-muted-foreground"
          >
            <span>
              {t(
                'orcaCloudWorkspace.terminal.asleepHistoryKept',
                'This workspace is asleep. Your terminal history is kept.'
              )}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void wakeCloudWorkspace(workspaceId)}
            >
              <Play />
              {t('orcaCloudWorkspace.wake', 'Wake')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
