import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { cn } from '@/lib/class-names'
import { formatBytes } from '../../../../../shared/text/format-bytes'
import { joinSentences } from '../../../../../shared/text/sentence-joining'
import type { WorkspaceCleanupReport } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { Button } from '../../ui/button'
import { SettingsGroup, SettingsGroupHeader } from '../section-layout/SettingsGroup'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { matchesSettingsSearch } from '../search/settings-search'
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
  const chats = run.chatHistory?.deleted ?? 0
  if (removed === 0 && chats > 0) {
    return t(
      'components.settings.workspaceCleanup.status.lastRunChats',
      'Last run {{when}} deleted {{count}} chats from deleted workspaces.',
      {
        when,
        count: chats,
        defaultValue_one: 'Last run {{when}} deleted 1 chat from a deleted workspace.'
      }
    )
  }
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

/**
 * The rules under a heading that says whether automatic cleanup is on, what it last did, and runs
 * the rules now. A search that matches only the heading shows it without the rules.
 */
export function WorkspaceCleanupAutomaticSection({
  anyRuleOn,
  report,
  readAt,
  cleaningUp,
  onCleanUpNow,
  showRules,
  children
}: {
  anyRuleOn: boolean
  report: WorkspaceCleanupReport | null
  /** When `report` was read. */
  readAt: number
  cleaningUp: boolean
  onCleanUpNow: () => void
  /** Whether the search matches a rule. */
  showRules: boolean
  /** The rule rows. */
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  const search = getWorkspaceCleanupSettingsSearchParts()
  const lastRun = report?.runs[0]
  const running = cleaningUp || report?.running === true
  const runningText = t(
    'components.settings.workspaceCleanup.automatic.running',
    'Removing what your rules match…'
  )
  // Screen readers hear a run start and each new run's result once; the visible line's relative
  // times re-render on every report read and would be read out again. Each announcement goes into
  // whichever of two regions is empty, so a result worded like the last one still changes the DOM.
  // Undefined until the report is read, so the first read's newest run is not news.
  const runId = report ? (lastRun?.id ?? null) : undefined
  const [announcement, setAnnouncement] = useState<{
    running: boolean
    runId: string | null | undefined
    text: string
    slot: 0 | 1
  }>({
    running,
    runId,
    text: '',
    slot: 0
  })
  if (running !== announcement.running || runId !== announcement.runId) {
    const newRun =
      announcement.runId !== undefined && lastRun && lastRun.id !== announcement.runId
        ? lastRun
        : null
    // A run can start in the same update that brings a new result; say the result first, then the
    // start, so neither is lost. The new run's id is only recorded alongside its announcement.
    const parts = [
      newRun ? formatLastRun(newRun, readAt, t) : null,
      running && !announcement.running ? runningText : null
    ].filter((part): part is string => part !== null)
    const text = parts.length > 0 ? joinSentences(parts) : null
    setAnnouncement({
      running,
      runId,
      text: text ?? announcement.text,
      slot: text === null ? announcement.slot : announcement.slot === 0 ? 1 : 0
    })
  }
  const details: string[] = []
  if (!anyRuleOn) {
    details.push(
      t(
        'components.settings.workspaceCleanup.automatic.offDetail',
        'Turn on a rule to remove workspaces on a schedule.'
      )
    )
  } else if (running) {
    details.push(runningText)
  } else {
    if (lastRun) {
      details.push(formatLastRun(lastRun, readAt, t))
    }
    if (report?.nextRunAt) {
      details.push(
        t('components.settings.workspaceCleanup.status.nextRun', 'Next run {{when}}.', {
          when: formatRunTime(Math.max(0, report.nextRunAt - readAt), t)
        })
      )
    }
  }

  const title = (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="whitespace-nowrap">
        {t('components.settings.workspaceCleanup.automatic.title', 'Automatic cleanup')}
      </span>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 text-[11.5px] font-medium leading-5 text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full',
            anyRuleOn ? 'bg-status-success' : 'bg-muted-foreground/60'
          )}
        />
        {anyRuleOn
          ? t('components.settings.workspaceCleanup.automatic.on', 'On')
          : t('components.settings.workspaceCleanup.automatic.off', 'Off')}
      </span>
    </span>
  )
  const description =
    details.length > 0 ? <span className="tabular-nums">{joinSentences(details)}</span> : null
  const action = anyRuleOn ? (
    <Button variant="outline" size="sm" disabled={running} onClick={onCleanUpNow}>
      {running ? (
        <>
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          {t('components.settings.workspaceCleanup.automatic.runningButton', 'Running…')}
        </>
      ) : (
        t('components.settings.workspaceCleanup.automatic.runNow', 'Run rules now')
      )}
    </Button>
  ) : null

  const announcer = (
    <>
      <span role="status" className="sr-only">
        {announcement.slot === 0 ? announcement.text : ''}
      </span>
      <span role="status" className="sr-only">
        {announcement.slot === 1 ? announcement.text : ''}
      </span>
    </>
  )
  const showHeading = showRules || matchesSettingsSearch(query, [search.status])
  return (
    <>
      {announcer}
      {showHeading ? (
        <div className="space-y-3">
          {/* Search lands on the heading, which is shown whether rules are off, on or running. */}
          <SearchableSetting {...search.status} forceVisible>
            <SettingsGroupHeader
              title={title}
              description={description}
              action={action}
              wrapAction
            />
          </SearchableSetting>
          {showRules ? (
            <SettingsGroup>
              {children}
              {query.trim() === '' ? (
                <p data-settings-row="" className="py-3 text-xs text-muted-foreground">
                  {t(
                    'components.settings.workspaceCleanup.rules.branchNote',
                    'Merged branches are deleted with their workspace. Unmerged branches are kept.'
                  )}
                </p>
              ) : null}
            </SettingsGroup>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
