import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

import { isAgentHookSource, type AgentHookSource } from './agent-hook-relay'
import { buildSpoolHookBody, drainAgentHookSpool, launchTokenHash } from './agent-hook-spool'
import {
  AGENT_HOOK_INBOX_DIR_NAME,
  parseAgentHookInboxRecord,
  type AgentHookInboxRecord
} from './agent-hook-inbox-record'
import {
  claim,
  ensurePrivateDirectory,
  listPendingRecords,
  listRecordNames,
  readCompleteRecord,
  type PendingRecord
} from './agent-hook-inbox-files'

/** Why: the sweep, not the watcher, guarantees delivery; a platform watcher can arm and then
 *  deliver nothing. The watcher only makes delivery faster than this. */
export const AGENT_HOOK_INBOX_SWEEP_MS = 1_000
/** Without a watcher (inotify limits exhausted, say) the sweep is the only wake-up. */
export const AGENT_HOOK_INBOX_UNWATCHED_SWEEP_MS = 100
/** Time a background drain may hold the event loop per turn; a backlog left while Orca was closed
 *  is replayed in slices instead of one long main-thread stall. */
export const AGENT_HOOK_INBOX_BACKGROUND_SLICE_MS = 8
/** A record still unterminated this long after its last write belongs to a killed writer. */
export const AGENT_HOOK_INBOX_TORN_RECORD_MAX_AGE_MS = 10 * 60 * 1000
/** Same replay horizon as the legacy spool and last-status hydration. */
export const AGENT_HOOK_INBOX_MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type AgentHookInboxIngest = (
  record: AgentHookInboxRecord,
  meta: { isReplay: boolean }
) => void

export function agentHookInboxDir(endpointDir: string): string {
  return join(endpointDir, AGENT_HOOK_INBOX_DIR_NAME)
}

export type CommittedHookIngest = (
  source: AgentHookSource,
  body: Record<string, unknown>,
  meta: { isReplay: boolean }
) => void

/**
 * Takes ownership of every hook event committed to disk for one endpoint: replays the legacy
 * spool (written by hook scripts whose POST failed) and the inbox backlog, then keeps the inbox
 * draining live. Returns null when there is no inbox to own; the caller must then not advertise
 * it, so hook scripts keep POSTing.
 */
export function openAgentHookInbox(options: {
  endpointDir: string
  ingest: CommittedHookIngest
  /** Launch the host last saw for a pane; a replay from any other launch is stale. */
  persistedLaunchTokenHash?: (paneKey: string) => string | undefined
  /** False when this host cannot drain before the pane's output is published (see the WSL relay). */
  inbox?: boolean
}): AgentHookInbox | null {
  const isStaleReplay = (paneKey: unknown, launchToken: unknown): boolean => {
    const expected =
      typeof paneKey === 'string' ? options.persistedLaunchTokenHash?.(paneKey) : undefined
    return (
      Boolean(expected) &&
      launchTokenHash(typeof launchToken === 'string' ? launchToken : undefined) !== expected
    )
  }
  const ingest = (source: string, body: Record<string, unknown>, isReplay: boolean): void => {
    if (isAgentHookSource(source) && !(isReplay && isStaleReplay(body.paneKey, body.launchToken))) {
      options.ingest(source, body, { isReplay })
    }
  }
  try {
    drainAgentHookSpool({
      endpointDir: options.endpointDir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest: (record) => ingest(record.source, buildSpoolHookBody(record), true)
    })
  } catch (error) {
    // Why: a replay failure must not stop the host from starting; the spool stays for next time.
    console.error('[agent-hooks] spool replay failed:', error)
  }
  // Why Windows is excluded: no Windows hook commits yet (.cmd hooks still POST), so a watcher and
  // sweep there would only cost main-thread work.
  if (options.inbox === false || process.platform === 'win32') {
    return null
  }
  const inbox = new AgentHookInbox(
    agentHookInboxDir(options.endpointDir),
    ({ source, body }, { isReplay }) => ingest(source, body, isReplay)
  )
  if (!inbox.open()) {
    return null
  }
  // Why not drain here: a backlog can be thousands of records; background slices replay it while
  // any decision point that needs it first still forces a full drain.
  inbox.scheduleDrain()
  return inbox
}

/**
 * Owns one endpoint's hook inbox: managed hook scripts commit one file per event, and this
 * drains them in commit order through the same ingest the HTTP listener uses.
 *
 * A record is claimed by unlinking it: only a successful unlink admits it, so a record is
 * ingested at most once however many drains race. Records already present when the inbox
 * opens were committed while nothing was draining and are replays; everything later is live.
 */
export class AgentHookInbox {
  private watcher: FSWatcher | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private wakeScheduled = false
  private draining = false
  private drainAgain = false
  private replayNames = new Set<string>()
  private sorted: PendingRecord[] = []
  private unfinishedRecordStamps = new Map<string, string>()
  private sortedCursor = 0
  private isOpen = false

  constructor(
    private readonly dir: string,
    private readonly ingest: AgentHookInboxIngest,
    private readonly now: () => number = Date.now
  ) {}

  get path(): string {
    return this.dir
  }

  /** Arms the watcher and sweep, then snapshots the backlog as replays. Returns false when the
   *  directory is not private to this user; the caller must then not advertise the inbox. */
  open(): boolean {
    if (this.isOpen) {
      return true
    }
    if (!ensurePrivateDirectory(this.dir)) {
      return false
    }
    try {
      // Why: armed before the backlog scan, so a record committed between the scan and arming
      // cannot wait for the sweep (the previous run's endpoint file already advertises us).
      this.watcher = watch(this.dir, { persistent: false }, () => this.scheduleDrain())
      this.watcher.on('error', () => {
        this.closeWatcher()
        this.armSweep()
      })
    } catch {
      this.watcher = null
    }
    this.armSweep()
    this.replayNames = new Set(listRecordNames(this.dir))
    this.isOpen = true
    return true
  }

  close(): void {
    this.isOpen = false
    this.closeWatcher()
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.replayNames.clear()
    this.sorted = []
    this.sortedCursor = 0
    this.unfinishedRecordStamps.clear()
  }

  /** Synchronously ingests every complete record in commit order and returns how many it applied.
   *  Callers that decide a pane's fate (process exit, retirement, interrupt inference) call this
   *  first, so an event the agent committed before that moment is applied before it, as the old
   *  blocking POST guaranteed. */
  drain(deadline = Number.POSITIVE_INFINITY): number {
    if (!this.isOpen) {
      return 0
    }
    if (this.draining) {
      // Why: an ingest listener re-entered a decision point; the outer pass picks up the rest.
      this.drainAgain = true
      return 0
    }
    this.draining = true
    let applied = 0
    try {
      do {
        this.drainAgain = false
        applied += this.drainOnce(deadline)
      } while (this.drainAgain && this.isOpen && performance.now() < deadline)
    } finally {
      this.draining = false
    }
    return applied
  }

  private armSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
    }
    this.sweepTimer = setInterval(
      () => this.scheduleDrain(),
      this.watcher ? AGENT_HOOK_INBOX_SWEEP_MS : AGENT_HOOK_INBOX_UNWATCHED_SWEEP_MS
    )
    this.sweepTimer.unref?.()
  }

  /** Drains in background slices until nothing complete is left. */
  scheduleDrain(): void {
    if (this.wakeScheduled) {
      return
    }
    this.wakeScheduled = true
    setImmediate(() => {
      this.wakeScheduled = false
      this.drain(performance.now() + AGENT_HOOK_INBOX_BACKGROUND_SLICE_MS)
      if (this.sortedCursor < this.sorted.length) {
        this.scheduleDrain()
      }
    })
  }

  private closeWatcher(): void {
    try {
      this.watcher?.close()
    } catch {
      // already closed
    }
    this.watcher = null
  }

  /** One pass: finish the sorted remainder a sliced drain left, then list the directory once for
   *  anything newer. Listing once per pass keeps a sliced replay linear in the backlog. */
  private drainOnce(deadline: number): number {
    let applied = 0
    let listed = false
    // Why a deadline, not a count: every record visited costs I/O, applied or not.
    while (this.isOpen && performance.now() < deadline) {
      if (this.sortedCursor >= this.sorted.length) {
        if (listed) {
          break
        }
        this.sorted = listPendingRecords(this.dir)
        this.sortedCursor = 0
        listed = true
        if (this.unfinishedRecordStamps.size > 0) {
          const listedNames = new Set(this.sorted.map(({ name }) => name))
          for (const name of this.unfinishedRecordStamps.keys()) {
            if (!listedNames.has(name)) {
              this.unfinishedRecordStamps.delete(name)
            }
          }
        }
        if (this.sorted.length === 0) {
          break
        }
      }
      const entry = this.sorted[this.sortedCursor]
      this.sortedCursor += 1
      if (this.admit(entry, this.now())) {
        applied += 1
      }
    }
    return applied
  }

  /** Returns whether the record was handed to ingest. */
  private admit(entry: PendingRecord, now: number): boolean {
    const torn = now - entry.mtimeMs > AGENT_HOOK_INBOX_TORN_RECORD_MAX_AGE_MS
    const stamp = `${entry.size}:${entry.mtimeMs}`
    // Why: a writer still mid-record (or killed mid-write) must not be re-read on every drain;
    // publish barriers drain per output chunk.
    if (!torn && this.unfinishedRecordStamps.get(entry.name) === stamp) {
      return false
    }
    const bytes = readCompleteRecord(entry.path)
    if (bytes === 'incomplete') {
      if (torn) {
        claim(entry.path)
        this.replayNames.delete(entry.name)
        this.unfinishedRecordStamps.delete(entry.name)
      } else {
        this.unfinishedRecordStamps.set(entry.name, stamp)
      }
      return false
    }
    this.unfinishedRecordStamps.delete(entry.name)
    if (!claim(entry.path)) {
      return false
    }
    const isReplay = this.replayNames.delete(entry.name)
    if (bytes === 'invalid' || now - entry.mtimeMs > AGENT_HOOK_INBOX_MAX_RECORD_AGE_MS) {
      return false
    }
    const parsed = parseAgentHookInboxRecord(bytes)
    if (parsed.kind !== 'complete') {
      return false
    }
    try {
      this.ingest(parsed.record, { isReplay })
    } catch (error) {
      // Why: one bad record must not wedge the records committed after it.
      console.error('[agent-hooks] hook inbox record ingest failed:', error)
    }
    return true
  }
}
