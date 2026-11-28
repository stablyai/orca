import { CodexSubagentPollScheduler } from './codex-subagent-poll-scheduler'
import {
  createTranscriptNativeWatcher,
  type TranscriptNativeWatcher
} from './transcript-native-watcher'
import { isWslUncPath } from '../../file-access/wsl-paths'

const ROOT_RECONCILIATION_MS = 5_000

type TranscriptWakeup<T> = {
  value: T
  filePath?: string
  watcher?: TranscriptNativeWatcher
  watcherBound: boolean
  nextBindAt: number
  scheduled: boolean
  delayMs: number
  eventPending: boolean
  initialCheck: boolean
  /** A deadline reached while this key's async poll was reading; it reruns once that poll settles. */
  dueWhileInFlight: boolean
}

/** One deadline timer; root-only sessions use targeted file events with a sparse safety probe. An async poll keeps one read in flight per key and schedules its next tick only after it settles. */
export class AgentTranscriptPollScheduler<T> {
  private readonly entries = new Map<string, TranscriptWakeup<T>>()
  private readonly inFlight = new Map<string, TranscriptWakeup<T>>()
  private readonly deadlines: CodexSubagentPollScheduler<TranscriptWakeup<T>>

  constructor(
    private readonly delayMs: number,
    private readonly onDue: (key: string, value: T) => void | Promise<void>
  ) {
    this.deadlines = new CodexSubagentPollScheduler(delayMs, (key, entry) => {
      if (this.entries.get(key) !== entry) {
        return
      }
      entry.scheduled = false
      entry.eventPending = false
      if (this.inFlight.has(key)) {
        entry.dueWhileInFlight = true
        return
      }
      entry.initialCheck = false
      let pending: void | Promise<void> = undefined
      try {
        pending = this.onDue(key, entry.value)
      } finally {
        if (pending) {
          this.inFlight.set(key, entry)
          void pending
            .catch((error: unknown) => {
              console.error('[agent-hooks] transcript poll failed:', error)
            })
            .finally(() => this.settle(key, entry))
        } else if (this.entries.get(key) === entry && !entry.scheduled) {
          this.clear(key)
        }
      }
    })
  }

  private settle(key: string, entry: TranscriptWakeup<T>): void {
    if (this.inFlight.get(key) === entry) {
      this.inFlight.delete(key)
    }
    const current = this.entries.get(key)
    if (current?.dueWhileInFlight) {
      // A wake or newer hook came due mid-read; run again at the normal cadence instead of the sparse probe.
      current.dueWhileInFlight = false
      current.scheduled = true
      current.delayMs = this.delayMs
      this.deadlines.schedule(key, current, this.delayMs)
      return
    }
    if (current === entry && !entry.scheduled) {
      this.clear(key)
    }
  }

  /** An explicit `delayMs` shorter than the pending one (a Muse hook ending a quiet back-off) replaces it. */
  schedule(key: string, value: T, filePath?: string, delayMs?: number): void {
    let entry = this.entries.get(key)
    if (entry && entry.filePath !== filePath) {
      this.clear(key)
      entry = undefined
    }
    if (!entry) {
      entry = {
        value,
        filePath,
        watcherBound: false,
        nextBindAt: 0,
        scheduled: false,
        delayMs: this.delayMs,
        eventPending: false,
        initialCheck: true,
        dueWhileInFlight: false
      }
      this.entries.set(key, entry)
      if (filePath && !isWslUncPath(filePath)) {
        const watchedEntry = entry
        const wake = (): void => {
          if (this.entries.get(key) !== watchedEntry) {
            return
          }
          if (watchedEntry.watcher?.needsRebind()) {
            watchedEntry.watcherBound = false
            watchedEntry.nextBindAt = 0
          }
          if (watchedEntry.eventPending) {
            return
          }
          watchedEntry.eventPending = true
          watchedEntry.scheduled = true
          watchedEntry.delayMs = this.delayMs
          this.deadlines.schedule(key, watchedEntry, this.delayMs)
        }
        entry.watcher = createTranscriptNativeWatcher(
          filePath,
          wake,
          () => {
            watchedEntry.watcherBound = false
            watchedEntry.nextBindAt = 0
            wake()
          },
          { watchParent: false }
        )
      }
    }
    entry.value = value
    // The pending callback reads this entry's latest hook, so repeated hooks need neither a new watch nor a new timer.
    if (entry.scheduled && !(delayMs !== undefined && delayMs < entry.delayMs)) {
      return
    }
    const now = performance.now()
    if (entry.watcher?.needsRebind() && now >= entry.nextBindAt) {
      entry.watcherBound = entry.watcher.bind()
      entry.nextBindAt = now + ROOT_RECONCILIATION_MS
    }
    const delay =
      delayMs ?? (entry.watcherBound && !entry.initialCheck ? ROOT_RECONCILIATION_MS : this.delayMs)
    entry.scheduled = true
    entry.delayMs = delay
    this.deadlines.schedule(key, entry, delay)
  }

  peek(key: string): T | undefined {
    return this.entries.get(key)?.value
  }

  clear(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) {
      return
    }
    this.entries.delete(key)
    // A read that never settles must not stall the pane's next poll forever.
    this.inFlight.delete(key)
    this.deadlines.clear(key)
    entry.watcher?.dispose()
  }

  clearAll(): void {
    this.inFlight.clear()
    this.deadlines.clearAll()
    for (const entry of this.entries.values()) {
      entry.watcher?.dispose()
    }
    this.entries.clear()
  }
}
