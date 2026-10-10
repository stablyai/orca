import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import { resumeRunInFlight, type ResumeRun } from './native-chat-resume-run'
import {
  resumeRunView,
  type ResumeRunFilter,
  type ResumeRunRowStatus,
  type ResumeRunView
} from './native-chat-resume-run-view'
import { ResumeRunStatusIcon } from './NativeChatResumeRunStatusIcon'
import { ResumeRunSummary } from './NativeChatResumeRunSummary'

/**
 * The dialog's view of the runs it is following, one per machine: its title, the progress line and
 * filters, each machine's rows in the order that matters, and each row's status icon. Null when no
 * machine has a run, so the dialog is then exactly the offer it was.
 */

/** One machine's part of the dialog: its run if it has one, its listed rows, and how its rows are
 *  keyed in the tree (two machines may hold the same session id). */
export type ResumeRunPart = {
  run: ResumeRun | null
  rows: readonly ResumeCandidate[]
  failureFor: (sessionId: string) => ResumeFailure | undefined
  keyOf: (sessionId: string) => string
}

export type ResumeRunPanel = {
  title: React.ReactNode
  /** Null once every run is over: the offer's own copy then describes what is left. */
  description: string | null
  summary: React.ReactNode
  /** Each part's rows, in the parts' order. */
  rows: ResumeCandidate[][]
  /** Keyed by the tree's row key. */
  renderStatus: (key: string, title: string) => React.ReactNode
}

function runTitle(inFlight: boolean, total: number, resumed: number): React.ReactNode {
  if (!inFlight) {
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

type Counts = ResumeRunView['counts']

const NO_COUNTS: Counts = { all: 0, total: 0, done: 0, inProgress: 0, resumed: 0, attention: 0 }

function addCounts(left: Counts, right: Counts): Counts {
  return {
    all: left.all + right.all,
    total: left.total + right.total,
    done: left.done + right.done,
    inProgress: left.inProgress + right.inProgress,
    resumed: left.resumed + right.resumed,
    attention: left.attention + right.attention
  }
}

/** A machine with no run still lists its rows under the same filters, as nothing this run touched. */
const NOT_RUN: ResumeRun = { startedAt: 0, entries: [], inFlight: false }

export function useResumeRunPanel({
  parts,
  open
}: {
  parts: readonly ResumeRunPart[]
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
  const followed = parts.flatMap((part) => (part.run ? [part.run] : []))
  const inFlightRuns = followed.filter(resumeRunInFlight)
  const inFlight = inFlightRuns.length > 0
  // Ticks only while a visible run is moving: the row timers and the running clock read it.
  const now = useNow(1000, open && inFlight)
  if (followed.length === 0) {
    return null
  }
  const views = parts.map((part) =>
    resumeRunView(part.run ?? NOT_RUN, part.rows, part.failureFor, filter.value)
  )
  const statusByKey = new Map<string, ResumeRunRowStatus>()
  views.forEach((view, index) => {
    for (const [sessionId, status] of view.statusBySession) {
      statusByKey.set(parts[index]!.keyOf(sessionId), status)
    }
  })
  const counts = views.reduce((total, view) => addCounts(total, view.counts), NO_COUNTS)
  const phaseFor = (key: string) => {
    const status = statusByKey.get(key)
    return status?.kind === 'in-flight' ? status.phase : null
  }
  const inFlightKeys = [...statusByKey].flatMap(([key, status]) =>
    status.kind === 'in-flight' ? [key] : []
  )
  // The clock runs from the earliest resume still moving, across machines.
  const startedAt = Math.min(...(inFlight ? inFlightRuns : followed).map((run) => run.startedAt))
  return {
    title: runTitle(inFlight, counts.total, counts.resumed),
    description: inFlight
      ? translate(
          'auto.components.NativeChatResumeRunPanel.description',
          'Each chat is restored with its full context and asked to check where it stopped. You can close this; the status bar keeps track.'
        )
      : null,
    summary: (
      <ResumeRunSummary
        counts={counts}
        phases={inFlightKeys.map(phaseFor)}
        startedAt={startedAt}
        now={now}
        filter={filter.value}
        onFilterChange={(value) => setFilter({ value, open })}
      />
    ),
    rows: views.map((view) => view.rows),
    renderStatus: (key, title) => {
      const status = statusByKey.get(key)
      return status ? (
        <ResumeRunStatusIcon status={status} phase={phaseFor(key)} now={now} title={title} />
      ) : null
    }
  }
}
