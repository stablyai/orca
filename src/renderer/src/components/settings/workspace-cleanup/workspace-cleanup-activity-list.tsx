import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { formatBytes } from '../../../../../shared/text/format-bytes'
import type {
  WorkspaceCleanupRun,
  WorkspaceCleanupRunRow
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { formatCleanupRunTrigger } from './workspace-cleanup-run-labels'
import { WorkspaceCleanupReasonChip } from './workspace-cleanup-reason-chip'
import {
  ActivityGroupLabel as GroupLabel,
  ActivityKeptRows as KeptRows,
  WIDE_ROW,
  WIDE_ROWS
} from './workspace-cleanup-activity-rows'
import {
  WorkspaceCleanupWorkspaceLine,
  workspaceCleanupRowKey
} from './workspace-cleanup-workspace-line'

/** Each run's receipt, newest first; the newest opens expanded. */
export function WorkspaceCleanupActivityList({
  runs
}: {
  runs: WorkspaceCleanupRun[]
}): React.JSX.Element {
  // Only the newest run opens by default; a run the viewer toggled keeps its state.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map())
  return (
    <>
      {runs.map((run, index) => (
        <ActivityRun
          key={run.id}
          run={run}
          open={toggled.get(run.id) ?? index === 0}
          onToggle={() =>
            setToggled((previous) => {
              // Carry only shown runs so ids that left the capped history drop out.
              const next = new Map<string, boolean>()
              for (const { id } of runs) {
                const value = previous.get(id)
                if (value !== undefined) {
                  next.set(id, value)
                }
              }
              return next.set(run.id, !(previous.get(run.id) ?? index === 0))
            })
          }
        />
      ))}
    </>
  )
}

function ActivityRun({
  run,
  open,
  onToggle
}: {
  run: WorkspaceCleanupRun
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const removed = run.rows.filter((row) => row.outcome === 'removed' || row.outcome === 'archived')
  const kept = run.rows.filter((row) => row.outcome === 'kept')
  const failed = run.rows.filter((row) => row.outcome === 'failed')
  const removedCount = run.counts.removed + run.counts.archived
  const chats = run.chatHistory?.deleted ?? 0
  const summary = [
    removedCount > 0
      ? t('components.settings.workspaceCleanup.activity.removedCount', '{{count}} removed', {
          count: removedCount
        })
      : null,
    chats > 0
      ? t(
          'components.settings.workspaceCleanup.activity.chatsDeletedCount',
          '{{count}} chats deleted',
          {
            count: chats,
            defaultValue_one: '1 chat deleted'
          }
        )
      : null
  ].filter((part): part is string => part !== null)
  const separator = t('components.settings.workspaceCleanup.listSeparator', ', ')
  const when = uiDateTimeFormat({
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(run.startedAt)
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div data-settings-row="" className="@container py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-start gap-x-2 text-left"
      >
        <span className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground">
          <Chevron className="size-3.5" />
        </span>
        {/* The chevron keeps its own column, so wrapped lines start under the date, not under it. */}
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="whitespace-nowrap text-sm font-medium tabular-nums">{when}</span>
          {/* A localized trigger can outgrow the narrowest run, so it wraps under the date. */}
          <span className="min-w-0 text-xs text-muted-foreground">
            {formatCleanupRunTrigger(run.trigger, t)}
          </span>
          {/* Fills the first line, so a result that does not fit wraps under the date. */}
          <span aria-hidden="true" className="grow" />
          <span className="text-xs tabular-nums text-muted-foreground">
            {run.error ? (
              <span className="text-destructive">
                {t('components.settings.workspaceCleanup.activity.unfinished', "Couldn't finish")}
              </span>
            ) : (
              <>
                {/* Each count stays whole, so a narrow header breaks only between counts.
                  Why: narrow conjunctions keep English "a, b" and give CJK its own comma. */}
                {new Intl.ListFormat(intlLocale, { type: 'conjunction', style: 'narrow' })
                  .formatToParts(
                    summary.length === 0
                      ? [
                          t(
                            'components.settings.workspaceCleanup.activity.nothingRemoved',
                            'Nothing to clean'
                          )
                        ]
                      : summary
                  )
                  .map((part, index) =>
                    part.type === 'element' ? (
                      // A count stays whole; "Nothing to clean" is a phrase and may wrap in a narrow pane.
                      <span
                        key={index}
                        className={summary.length > 0 ? 'whitespace-nowrap' : undefined}
                      >
                        {part.value}
                      </span>
                    ) : (
                      <Fragment key={index}>{part.value}</Fragment>
                    )
                  )}
                {separator}
                <span className="whitespace-nowrap">
                  {t('components.settings.workspaceCleanup.activity.keptCount', '{{count}} kept', {
                    count: run.counts.kept
                  })}
                </span>
                {run.counts.failed > 0 ? (
                  <>
                    {separator}
                    <span className="whitespace-nowrap text-destructive">
                      {t(
                        'components.settings.workspaceCleanup.activity.failedCount',
                        '{{count}} failed',
                        {
                          count: run.counts.failed
                        }
                      )}
                    </span>
                  </>
                ) : null}
              </>
            )}
          </span>
        </span>
      </button>
      {open ? (
        <div className="mt-1 pl-6">
          {run.error ? <ErrorLine message={run.error} /> : null}
          {removed.length > 0 ? (
            <>
              <GroupLabel>
                {t('components.settings.workspaceCleanup.activity.removed', 'Removed · {{count}}', {
                  count: removedCount
                })}
              </GroupLabel>
              <div
                className={`${WIDE_ROWS} @xl:grid-cols-[minmax(12rem,1fr)_minmax(0,auto)_auto_auto]`}
              >
                {removed.map((row) => (
                  <RemovedRow key={workspaceCleanupRowKey(row)} row={row} />
                ))}
              </div>
            </>
          ) : null}
          {run.chatHistory && (chats > 0 || run.chatHistory.failed > 0) ? (
            <ChatHistoryLines chatHistory={run.chatHistory} />
          ) : null}
          {kept.length > 0 ? <KeptRows rows={kept} total={run.counts.kept} /> : null}
          {failed.length > 0 ? (
            <>
              <GroupLabel>
                {t('components.settings.workspaceCleanup.activity.failed', 'Failed · {{count}}', {
                  count: run.counts.failed
                })}
              </GroupLabel>
              {failed.map((row) => (
                <div key={workspaceCleanupRowKey(row)} className="min-w-0 py-1.5">
                  <WorkspaceCleanupWorkspaceLine workspace={row} wrap />
                  {row.error ? <ErrorLine message={row.error} /> : null}
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ChatHistoryLines({
  chatHistory
}: {
  chatHistory: NonNullable<WorkspaceCleanupRun['chatHistory']>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <GroupLabel>
        {t('components.settings.workspaceCleanup.chatHistory.title', 'Chat history')}
      </GroupLabel>
      <p className="py-1.5 text-xs text-muted-foreground tabular-nums">
        {t(
          'components.settings.workspaceCleanup.activity.chatsDeleted',
          'Deleted {{count}} chats from deleted workspaces',
          {
            count: chatHistory.deleted,
            defaultValue_one: 'Deleted 1 chat from a deleted workspace'
          }
        )}
        {/* No-break spaces on both sides: the "·" neither starts nor ends a line; it stays with the size. */}
        {chatHistory.freedBytes > 0 ? (
          <>
            {'\u00a0·\u00a0'}
            <span className="whitespace-nowrap">{formatBytes(chatHistory.freedBytes)}</span>
          </>
        ) : null}
      </p>
      {chatHistory.failed > 0 ? (
        <ErrorLine
          message={t(
            'components.settings.workspaceCleanup.activity.chatsFailed',
            "{{count}} chats couldn't be deleted",
            { count: chatHistory.failed, defaultValue_one: "1 chat couldn't be deleted" }
          )}
        />
      ) : null}
    </>
  )
}

function ErrorLine({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="mt-0.5 flex items-start gap-1.5 text-xs text-destructive">
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{message}</span>
    </p>
  )
}

function RemovedRow({ row }: { row: WorkspaceCleanupRunRow }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={`flex flex-col items-start gap-y-1 py-1.5 ${WIDE_ROW} @xl:items-baseline`}>
      <WorkspaceCleanupWorkspaceLine workspace={row} wrap className="w-full" />
      {/* Narrow rows keep the reason, then outcome and size together, on lines of their own. */}
      <div className={cn('min-w-0 max-w-full', !row.reason && 'hidden @xl:block')}>
        {row.reason ? (
          <WorkspaceCleanupReasonChip reason={row.reason} prNumber={row.prNumber} wrap />
        ) : null}
      </div>
      {/* Outcome and size share a line when they fit; each stays whole if the narrowest pane splits them. */}
      <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground @xl:contents">
        <span className="whitespace-nowrap">
          {row.outcome === 'archived'
            ? t('components.settings.workspaceCleanup.activity.archived', 'Archived')
            : t('components.settings.workspaceCleanup.activity.deleted', 'Deleted')}
        </span>
        <span className="whitespace-nowrap text-right tabular-nums">
          {row.sizeBytes !== undefined ? formatBytes(row.sizeBytes) : null}
        </span>
      </span>
    </div>
  )
}
