import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import { resumeRunInFlight, type ResumeRun, type ResumeRunStarter } from './native-chat-resume-run'
import { resumeRunView, type ResumeRunFilter } from './native-chat-resume-run-view'
import { ResumeRunStatusIcon } from './NativeChatResumeRunStatusIcon'
import { ResumeRunSummary } from './NativeChatResumeRunSummary'

/**
 * The dialog's view of a run it is following: its title, the progress line and filters, the rows
 * in the order that matters, and each row's status icon. Null when no run is being followed, so
 * the dialog is then exactly the offer it was.
 */

export type ResumeRunPanel = {
  title: React.ReactNode
  description: string
  summary: React.ReactNode
  rows: ResumeCandidate[]
  finishedRowsVisible: boolean
  renderStatus: (sessionId: string, title: string) => React.ReactNode
  /** Whether any listed chat still shows a checkbox; when none does, the dialog is a result. */
  choosing: boolean
  startedBy: ResumeRunStarter
}

/** What the run did, in the past tense: the offer's copy describes an action not yet taken. */
function finishedDescription(everyChatResumed: boolean, byUpdate: boolean): string {
  if (everyChatResumed) {
    return byUpdate
      ? translate(
          'auto.components.NativeChatResumeRunPanel.finishedUpdate',
          'These chats were working when Orca installed an update. Orca restored each one where it stopped, with its full context, and asked the agent to check what it was doing before carrying on. Your own prompts weren’t re-sent.'
        )
      : translate(
          'auto.components.NativeChatResumeRunPanel.finished',
          'These chats were working when Orca closed. Orca restored each one where it stopped, with its full context, and asked the agent to check what it was doing before carrying on. Your own prompts weren’t re-sent.'
        )
  }
  return byUpdate
    ? translate(
        'auto.components.NativeChatResumeRunPanel.finishedPartialUpdate',
        'These chats were working when Orca installed an update. The ones Orca resumed were restored where they stopped, with their full context, and asked to check what they were doing before carrying on. Your own prompts weren’t re-sent. Check the list for chats that still need attention or can be resumed.'
      )
    : translate(
        'auto.components.NativeChatResumeRunPanel.finishedPartial',
        'These chats were working when Orca closed. The ones Orca resumed were restored where they stopped, with their full context, and asked to check what they were doing before carrying on. Your own prompts weren’t re-sent. Check the list for chats that still need attention or can be resumed.'
      )
}

function runTitle(run: ResumeRun, total: number, resumed: number): React.ReactNode {
  if (!resumeRunInFlight(run)) {
    if (total === 1) {
      return translate(
        'auto.components.NativeChatResumeRunPanel.resumedTitleOne',
        'Resumed {{value0}} of 1 chat',
        { value0: resumed }
      )
    }
    return translate(
      'auto.components.NativeChatResumeRunPanel.resumedTitle',
      'Resumed {{value0}} of {{value1}} chats',
      { value0: resumed, value1: total }
    )
  }
  return (
    <span className="flex items-center gap-2">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
      {total === 1
        ? translate('auto.components.NativeChatResumeRunPanel.resumingTitleOne', 'Resuming 1 chat')
        : translate(
            'auto.components.NativeChatResumeRunPanel.resumingTitle',
            'Resuming {{value0}} chats',
            { value0: total }
          )}
    </span>
  )
}

export function useResumeRunPanel({
  run,
  rows,
  failureFor,
  selectableIds,
  open
}: {
  run: ResumeRun | null
  rows: readonly ResumeCandidate[]
  failureFor: (sessionId: string) => ResumeFailure | undefined
  selectableIds: ReadonlySet<string>
  open: boolean
}): ResumeRunPanel | null {
  // Each opening and completed run starts on All so its finished rows can be seen.
  const inFlight = run !== null && resumeRunInFlight(run)
  const [filter, setFilter] = useState<{
    value: ResumeRunFilter
    open: boolean
    inFlight: boolean
  }>({
    value: 'all',
    open,
    inFlight
  })
  if (filter.open !== open || filter.inFlight !== inFlight) {
    setFilter({ value: 'all', open, inFlight })
  }
  // Ticks only while a visible run is moving: the row timers and the running clock read it.
  const now = useNow(1000, open && inFlight)
  const view = run ? resumeRunView(run, rows, failureFor, filter.value) : null
  const inFlightIds = view
    ? [...view.statusBySession].flatMap(([sessionId, status]) =>
        status.kind === 'in-flight' ? [sessionId] : []
      )
    : []
  const phaseFor = (sessionId: string) => {
    const status = view?.statusBySession.get(sessionId)
    return status?.kind === 'in-flight' ? status.phase : null
  }
  if (!run || !view) {
    return null
  }
  const visibleIds = new Set(view.rows.map((row) => row.sessionId))
  return {
    title: runTitle(run, view.counts.total, view.counts.resumed),
    description: inFlight
      ? translate(
          'auto.components.NativeChatResumeRunPanel.description',
          'Each chat is restored with its full context and asked to check where it stopped. You can close this; the status bar keeps track.'
        )
      : finishedDescription(
          view.counts.resumed === view.counts.all,
          run.entries.some((entry) => entry.candidate.trigger === 'update')
        ),
    summary: (
      <ResumeRunSummary
        counts={view.counts}
        phases={inFlightIds.map(phaseFor)}
        startedAt={run.startedAt}
        now={now}
        filter={filter.value}
        onFilterChange={(value) => setFilter({ value, open, inFlight })}
      />
    ),
    rows: view.rows,
    finishedRowsVisible: run.entries.every((entry) => visibleIds.has(entry.candidate.sessionId)),
    // Current selection ignores the filter, so changing tabs never moves the layout.
    choosing: [...selectableIds].some((sessionId) => !view.statusBySession.has(sessionId)),
    startedBy: run.startedBy,
    renderStatus: (sessionId, title) => {
      const status = view.statusBySession.get(sessionId)
      return status ? (
        <ResumeRunStatusIcon status={status} phase={phaseFor(sessionId)} now={now} title={title} />
      ) : null
    }
  }
}
