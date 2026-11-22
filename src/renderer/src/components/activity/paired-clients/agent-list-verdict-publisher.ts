import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { readRecordChanges } from '@/store/record-transitions/keyed-record-change-reads'
import type { AcceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type { AgentListPublication } from '../../../../../shared/agent-status/presentation/agent-list-status'
import {
  getActivityThreadInputs,
  readActivityThreadSnapshot,
  subscribeActivityThreads
} from '../threads/activity-thread-projection'
import {
  readActivityThread,
  subscribeActivityThreadChanges
} from '../threads/activity-thread-change-feed'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import { createAgentListVerdictTracker } from './agent-list-verdict-tracker'

const PUBLISH_INTERVAL_MS = 250

type Publisher = {
  publishNow: () => AgentListPublication
  stop: () => void
}

// One publisher per window; a paired client's change reads its threads and its next publish.
let publisher: Publisher | null = null

/** Store writes only mark panes; one timer per interval builds the threads and sends what changed. */
function startPublisher(): Publisher {
  const tracker = createAgentListVerdictTracker()
  let statuses: AcceptedAgentStatuses | null = null
  let stopStatuses = (): void => {}
  let acknowledgedAt: Readonly<Record<string, number>> | null = null
  let flushedInputs: ReturnType<typeof getActivityThreadInputs> | null = null
  let sentReset = false
  let lastSentAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const watchStatuses = (next: AcceptedAgentStatuses): void => {
    if (statuses?.sharesOwner(next)) {
      return
    }
    stopStatuses()
    statuses = next
    stopStatuses = next.subscribeChanges((keys) =>
      keys ? tracker.markPanes(keys) : tracker.markAll()
    )
    tracker.markAll()
  }

  const flush = (): AgentListPublication | null => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    lastSentAt = Date.now()
    // Building here, not per store write, keeps a burst of writes to one build per interval.
    flushedInputs = getActivityThreadInputs('all')
    const snapshot = readActivityThreadSnapshot('all', flushedInputs)
    const state = useAppStore.getState()
    watchStatuses(state.agentStatusByPaneKey)
    const acknowledged = state.acknowledgedAgentsByPaneKey
    if (acknowledgedAt !== null) {
      const changes = readRecordChanges(acknowledged, acknowledgedAt)
      if (changes?.kind === 'addressed') {
        tracker.markPanes(changes.keys)
      } else if (changes) {
        tracker.markAll()
      }
    }
    acknowledgedAt = acknowledged
    const changes = tracker.collect({
      threads: snapshot.allThreads,
      thread: (paneKey) => readActivityThread('all', paneKey),
      statuses: state.agentStatusByPaneKey,
      acknowledgedAt: acknowledged
    })
    if (!sentReset) {
      sentReset = true
      const publication = { publishedAt: lastSentAt, verdicts: tracker.snapshot() }
      window.api.agentStatus.publishListVerdicts?.({ kind: 'reset', publication })
      return publication
    }
    if (changes.removed.length > 0 || Object.keys(changes.changed).length > 0) {
      window.api.agentStatus.publishListVerdicts?.({
        kind: 'changes',
        publishedAt: lastSentAt,
        ...changes
      })
    }
    return null
  }

  // Store writes Activity does not read keep the same inputs and schedule nothing.
  const schedule = (): void => {
    if (timer === null && getActivityThreadInputs('all') !== flushedInputs) {
      timer = setTimeout(flush, Math.max(0, lastSentAt + PUBLISH_INTERVAL_MS - Date.now()))
    }
  }

  const stops = [
    subscribeActivityThreadChanges('all', (keys) =>
      keys ? tracker.markPanes(keys) : tracker.markAll()
    ),
    // Keeps the shared projection attached; each store write only schedules the next flush.
    subscribeActivityThreads('all', schedule)
  ]
  schedule()
  return {
    publishNow: () => flush() ?? { publishedAt: lastSentAt, verdicts: tracker.snapshot() },
    stop: () => {
      stops.forEach((stop) => stop())
      stopStatuses()
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

/** The window's threads as the store holds them now; null until the publisher runs. */
export function readPublishedAgentPaneThreads(): readonly AgentPaneThread[] | null {
  // Read fresh: a phone's clear must judge eligibility on the turn running now, not the last flush.
  return publisher
    ? readActivityThreadSnapshot('all', getActivityThreadInputs('all')).allThreads
    : null
}

/** Resolves with the verdicts for the store as it is now, after sending them to main. */
export function publishAgentListNow(): Promise<AgentListPublication> {
  if (!publisher) {
    return Promise.reject(new Error('agent_activity_not_ready'))
  }
  return Promise.resolve(publisher.publishNow())
}

/** Sends the desktop Agents list's verdicts to main, so worktree.ps shows paired clients the same list. */
export default function AgentListVerdictPublisher(): null {
  const ready = useAppStore((s) => s.persistedUIReady)
  useEffect(() => {
    // Unhydrated read stamps would mark every agent unread.
    if (!ready) {
      return
    }
    const started = startPublisher()
    publisher = started
    return () => {
      started.stop()
      if (publisher === started) {
        publisher = null
      }
      // Unmounted with no phone paired: stale verdicts would hide new agents from a later pairing.
      window.api.agentStatus.publishListVerdicts?.(null)
    }
  }, [ready])
  return null
}
