import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useAppStore } from '@/store'
import { formatBytes } from '../../../../../shared/format-bytes'
import type { WorkspaceCleanupReport } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { Button } from '../../ui/button'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'

// Intl says "this minute" for both directions under a minute, which reads oddly in a sentence.
function formatRunTime(diffMs: number, t: Translate): string {
  // Callers pass a past time as negative and a future one as zero or more.
  if (Math.abs(diffMs) >= 60_000) {
    return formatUiRelativeTime(diffMs)
  }
  return diffMs < 0
    ? t('components.settings.workspaceCleanup.status.justNow', 'just now')
    : t('components.settings.workspaceCleanup.status.inUnderAMinute', 'in under a minute')
}

function formatLastRun(
  run: WorkspaceCleanupReport['runs'][number],
  now: number,
  t: Translate
): string {
  const when = formatRunTime(Math.min(-1, run.finishedAt - now), t)
  if (run.error) {
    return t(
      'components.settings.workspaceCleanup.status.lastRunFailed',
      "Last run {{when}} couldn't finish: {{error}}",
      {
        when,
        error: run.error
      }
    )
  }
  const removed = run.counts.removed + run.counts.archived
  if (removed === 0) {
    return t(
      'components.settings.workspaceCleanup.status.lastRunNothing',
      'Last run {{when}} removed nothing.',
      {
        when
      }
    )
  }
  return run.freedBytes > 0
    ? t(
        'components.settings.workspaceCleanup.status.lastRunFreed',
        'Last run {{when}} removed {{count}} workspaces and freed {{size}}.',
        {
          when,
          count: removed,
          size: formatBytes(run.freedBytes),
          defaultValue_one: 'Last run {{when}} removed 1 workspace and freed {{size}}.'
        }
      )
    : t(
        'components.settings.workspaceCleanup.status.lastRunRemoved',
        'Last run {{when}} removed {{count}} workspaces.',
        { when, count: removed, defaultValue_one: 'Last run {{when}} removed 1 workspace.' }
      )
}

/** Whether automatic cleanup is on, what it last did, and the two ways to act now. */
export function WorkspaceCleanupSettingsStatus({
  anyRuleOn,
  report,
  readAt,
  cleaningUp,
  onCleanUpNow
}: {
  anyRuleOn: boolean
  report: WorkspaceCleanupReport | null
  /** When `report` was read. */
  readAt: number
  cleaningUp: boolean
  onCleanUpNow: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((state) => state.openModal)
  const search = getWorkspaceCleanupSettingsSearchParts()
  const lastRun = report?.runs[0]
  const running = cleaningUp || report?.running === true
  const details: string[] = []
  if (!anyRuleOn) {
    details.push(
      t(
        'components.settings.workspaceCleanup.status.offDetail',
        'Nothing is removed until you turn on a rule.'
      )
    )
  } else {
    if (running) {
      details.push(t('components.settings.workspaceCleanup.status.running', 'Cleaning up now…'))
    } else if (lastRun) {
      details.push(formatLastRun(lastRun, readAt, t))
    }
    if (!running && report?.nextRunAt) {
      details.push(
        t('components.settings.workspaceCleanup.status.nextRun', 'Next run {{when}}.', {
          when: formatRunTime(Math.max(0, report.nextRunAt - readAt), t)
        })
      )
    }
  }

  return (
    <SearchableSetting {...search.status} className="flex items-start justify-between gap-6 px-1">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold">
          {anyRuleOn
            ? t('components.settings.workspaceCleanup.status.on', 'Automatic cleanup is on.')
            : t('components.settings.workspaceCleanup.status.off', 'Automatic cleanup is off.')}
        </p>
        {details.map((line) => (
          <p key={line} className="text-xs tabular-nums text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => openModal('workspace-cleanup')}
            className="text-xs text-muted-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:text-foreground"
          >
            {t('components.settings.workspaceCleanup.status.review', 'Review workspaces')}
          </button>
          <Button
            variant="outline"
            size="sm"
            disabled={!anyRuleOn || running}
            onClick={onCleanUpNow}
          >
            {search.status.title}
          </Button>
        </div>
        {anyRuleOn ? null : (
          <p className="text-xs text-muted-foreground">
            {t(
              'components.settings.workspaceCleanup.status.turnOnHint',
              'Turn on a rule to use this.'
            )}
          </p>
        )}
      </div>
    </SearchableSetting>
  )
}
