import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  Archive,
  ArrowUpFromLine,
  Bot,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  CircleMinus,
  Clock,
  Eye,
  FileDiff,
  FileLock,
  FilePen,
  Loader,
  Pin,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceCleanupRunRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import type { WorkspaceCleanupKeepCause } from '../../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { Button } from '../../ui/button'
import { formatAtRiskLocalFileNames } from '@/lib/workspace/display/at-risk-local-files-label'
import { WorkspaceCleanupMetadataText } from '@/components/workspace-cleanup/candidate-list/workspace-cleanup-metadata-chip'
import { formatCleanupKeepCause } from './workspace-cleanup-run-labels'
import {
  WorkspaceCleanupWorkspaceLine,
  workspaceCleanupRowKey
} from './workspace-cleanup-workspace-line'

const KEPT_PREVIEW_COUNT = 4

const KEEP_CAUSE_ICONS: Partial<Record<WorkspaceCleanupKeepCause, LucideIcon>> = {
  pinned: Pin,
  'recently-active': Clock,
  'active-workspace': Eye,
  'agent-running': Bot,
  'terminal-running': SquareTerminal,
  'terminal-unknown': SquareTerminal,
  'unsaved-editor-changes': FilePen,
  'uncommitted-changes': FileDiff,
  'unpushed-commits': ArrowUpFromLine,
  'ignored-files': FileLock,
  'git-unknown': CircleHelp,
  'archive-unavailable': Archive,
  'archive-script': Archive,
  removing: Loader
}

// Why a container query: the settings pane is 320px at the minimum window, too narrow for four
// columns, so rows stack name over facts until the run has room. Wide rows share one subgrid so
// each column sizes to its longest localized label instead of a fixed width that clips; the name
// column keeps 12rem so a long reason wraps before the workspace name does.
export const WIDE_ROWS = '@xl:grid @xl:items-center @xl:gap-x-4'
export const WIDE_ROW = '@xl:col-span-full @xl:grid @xl:grid-cols-subgrid'

/** The small muted label above each outcome group in a run's receipt. */
export function ActivityGroupLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="pt-2 pb-0.5 text-xs font-medium text-muted-foreground">{children}</p>
}

export function ActivityKeptRows({
  rows,
  total
}: {
  rows: WorkspaceCleanupRunRow[]
  total: number
}): React.JSX.Element {
  const t = useTranslate()
  const [showAll, setShowAll] = useState(false)
  const rowsId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const visible = showAll ? rows : rows.slice(0, KEPT_PREVIEW_COUNT)
  const hidden = rows.length - KEPT_PREVIEW_COUNT
  const notListed = total - rows.length
  return (
    <>
      <ActivityGroupLabel>
        {t('components.settings.workspaceCleanup.activity.kept', 'Kept · {{count}}', {
          count: total
        })}
      </ActivityGroupLabel>
      {/* Capping the reason track keeps one long reason from pushing every name onto two lines. */}
      <div
        id={rowsId}
        className={`${WIDE_ROWS} @xl:grid-cols-[minmax(12rem,1fr)_fit-content(50%)]`}
      >
        {visible.map((row) => (
          <div
            key={workspaceCleanupRowKey(row)}
            className={`flex flex-col items-start gap-y-1 py-1.5 ${WIDE_ROW}`}
          >
            <WorkspaceCleanupWorkspaceLine workspace={row} wrap className="w-full" />
            <KeptReason row={row} />
          </div>
        ))}
      </div>
      {(hidden <= 0 || showAll) && notListed > 0 ? (
        // The host saves a capped receipt, so a busy run lists fewer rows than it kept.
        <p className="py-1 text-xs text-muted-foreground">
          {t(
            'components.settings.workspaceCleanup.activity.notListed',
            '{{count}} more kept workspaces are not listed.',
            {
              count: notListed,
              defaultValue_one: '1 more kept workspace is not listed.'
            }
          )}
        </p>
      ) : null}
      {hidden > 0 ? (
        // One toggle in place both ways, so keyboard focus never drops to the page.
        <div className="py-1">
          <Button
            ref={toggleRef}
            type="button"
            variant="ghost"
            size="xs"
            className="-ml-1.5 scroll-my-1"
            aria-expanded={showAll}
            aria-controls={rowsId}
            onClick={() => {
              // Rows resize above the toggle, so keep it and its focus ring on screen.
              flushSync(() => setShowAll((value) => !value))
              toggleRef.current?.scrollIntoView({ block: 'nearest' })
            }}
          >
            {showAll
              ? t('components.settings.workspaceCleanup.activity.showFewer', 'Show fewer')
              : t('components.settings.workspaceCleanup.activity.showMore', 'Show {{count}} more', {
                  count: hidden
                })}
            {showAll ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </Button>
        </div>
      ) : null}
    </>
  )
}

function KeptReason({ row }: { row: WorkspaceCleanupRunRow }): React.JSX.Element | null {
  const t = useTranslate()
  if (row.keepCause === 'waiting' && row.waiting) {
    const { elapsedDays, afterDays } = row.waiting
    return (
      // Words first, then the meter, in both layouts. Stacked, the words start where the other
      // reasons' text starts (after their 12px icon and 4px gap).
      <span className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 pl-4 @xl:flex-nowrap @xl:justify-self-end @xl:pl-0">
        <span className="min-w-0 text-xs tabular-nums text-muted-foreground">
          {t(
            'components.settings.workspaceCleanup.activity.waiting',
            'Inactive {{elapsed}} of {{after}} days',
            { elapsed: elapsedDays, after: afterDays }
          )}
        </span>
        <span className="relative h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground"
            style={{
              width: `${Math.round((Math.min(elapsedDays, afterDays) / afterDays) * 100)}%`
            }}
          />
        </span>
      </span>
    )
  }
  if (!row.keepCause) {
    return null
  }
  const names =
    row.keepCause === 'ignored-files' && row.ignoredFiles
      ? formatAtRiskLocalFileNames(row.ignoredFiles, t)
      : null
  const cause = formatCleanupKeepCause(row.keepCause, t)
  const label = names
    ? t('components.settings.workspaceCleanup.keep.withDetail', '{{cause}} · {{detail}}', {
        cause,
        detail: names
      })
    : cause
  return (
    <WorkspaceCleanupMetadataText
      icon={KEEP_CAUSE_ICONS[row.keepCause] ?? CircleMinus}
      label={label}
      value={label}
      wrap
      className="@xl:justify-self-end"
    />
  )
}
