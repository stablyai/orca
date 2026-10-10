import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import { resumeRunInFlight, type ResumeRun } from './native-chat-resume-run'
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
  /** Null once the run is over: the offer's own copy then describes what is left. */
  description: string | null
  summary: React.ReactNode
  rows: ResumeCandidate[]
  renderStatus: (sessionId: string, title: string) => React.ReactNode
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
  open
}: {
  run: ResumeRun | null
  rows: readonly ResumeCandidate[]
  failureFor: (sessionId: string) => ResumeFailure | undefined
  open: boolean
}): ResumeRunPanel | null {
  // Each opening starts on All, as the dialog's own ticks start from their defaults.
  const [filter, setFilter] = useState<{ value: ResumeRunFilter; open: boolean }>({
    value: 'all',
    open
  })
  if (filter.open !== open) {
    setFilter({ value: 'all', open })
  }
  const inFlight = run !== null && resumeRunInFlight(run)
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
  return {
    title: runTitle(run, view.counts.total, view.counts.resumed),
    description: inFlight
      ? translate(
          'auto.components.NativeChatResumeRunPanel.description',
          'Each chat is restored with its full context and asked to check where it stopped. You can close this; the status bar keeps track.'
        )
      : null,
    summary: (
      <ResumeRunSummary
        counts={view.counts}
        phases={inFlightIds.map(phaseFor)}
        startedAt={run.startedAt}
        now={now}
        filter={filter.value}
        onFilterChange={(value) => setFilter({ value, open })}
      />
    ),
    rows: view.rows,
    renderStatus: (sessionId, title) => {
      const status = view.statusBySession.get(sessionId)
      return status ? (
        <ResumeRunStatusIcon status={status} phase={phaseFor(sessionId)} now={now} title={title} />
      ) : null
    }
  }
}
