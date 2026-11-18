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
}

/** One deadline timer; root-only sessions use targeted file events with a sparse safety probe. */
export class AgentTranscriptPollScheduler<T> {
  private readonly entries = new Map<string, TranscriptWakeup<T>>()
  private readonly deadlines: CodexSubagentPollScheduler<TranscriptWakeup<T>>

  /** `onFileEvent` hears which watched file changed, for callers that track per-file writes. */
  constructor(
    private readonly delayMs: number,
    private readonly onDue: (key: string, value: T) => void,
    private readonly onFileEvent?: (key: string, fileName: string) => void
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

  /** An explicit `delayMs` shorter than the pending one (a Muse hook ending a quiet back-off) replaces it. */
  /** `acceptsName` widens the watch to sibling files in the same directory (a session's children). */
  schedule(
    key: string,
    value: T,
    filePath?: string,
    delayMs?: number,
    acceptsName?: (name: string) => boolean
  ): void {
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
          watchedEntry.delayMs = this.delayMs
          this.deadlines.schedule(key, watchedEntry, this.delayMs)
        }
        entry.watcher = createTranscriptNativeWatcher(
          filePath,
          (fileName) => {
            if (fileName && this.entries.get(key) === watchedEntry) {
              this.onFileEvent?.(key, fileName)
            }
            wake()
          },
          () => {
            watchedEntry.watcherBound = false
            watchedEntry.nextBindAt = 0
            wake()
          },
          // Why: on Windows a watch on the file opens it, so a scanner holding the rollout stalls
          // the main thread; the directory watch filters events to this file instead.
          { watchParent: true, acceptsName }
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
