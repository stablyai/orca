import { CodexSubagentPollScheduler } from './codex-subagent-poll-scheduler'
import {
  createTranscriptNativeWatcher,
  type TranscriptNativeWatcher
} from './transcript-native-watcher'
import { isWslUncPath } from './wsl-paths'

const ROOT_RECONCILIATION_MS = 5_000

type TranscriptWakeup<T> = {
  value: T
  filePath?: string
  watcher?: TranscriptNativeWatcher
  watcherBound: boolean
  nextBindAt: number
  scheduled: boolean
  eventPending: boolean
  initialCheck: boolean
}

/** One deadline timer; root-only sessions use targeted file events with a sparse safety probe. */
export class AgentTranscriptPollScheduler<T> {
  private readonly entries = new Map<string, TranscriptWakeup<T>>()
  private readonly deadlines: CodexSubagentPollScheduler<TranscriptWakeup<T>>

  constructor(
    private readonly delayMs: number,
    private readonly onDue: (key: string, value: T) => void
  ) {
    this.deadlines = new CodexSubagentPollScheduler(delayMs, (key, entry) => {
      if (this.entries.get(key) !== entry) {
        return
      }
      entry.scheduled = false
      entry.eventPending = false
      entry.initialCheck = false
      try {
        this.onDue(key, entry.value)
      } finally {
        if (this.entries.get(key) === entry && !entry.scheduled) {
          this.clear(key)
        }
      }
    })
  }

  schedule(key: string, value: T, filePath?: string): void {
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
        eventPending: false,
        initialCheck: true
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
    if (entry.scheduled) {
      return
    }
    const now = performance.now()
    if (entry.watcher?.needsRebind() && now >= entry.nextBindAt) {
      entry.watcherBound = entry.watcher.bind()
      entry.nextBindAt = now + ROOT_RECONCILIATION_MS
    }
    const delay = entry.watcherBound && !entry.initialCheck ? ROOT_RECONCILIATION_MS : this.delayMs
    entry.scheduled = true
    this.deadlines.schedule(key, entry, delay)
  }

  clear(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) {
      return
    }
    this.entries.delete(key)
    this.deadlines.clear(key)
    entry.watcher?.dispose()
  }

  clearAll(): void {
    this.deadlines.clearAll()
    for (const entry of this.entries.values()) {
      entry.watcher?.dispose()
    }
    this.entries.clear()
  }
}
