import type {
  GeneratedAgentInputNotice,
  GeneratedInputNoticeFrame
} from './generated-agent-input-notice'

type Entry = { frame: GeneratedInputNoticeFrame; text: string }

/** One complete notice appearing or going, for consumers that keep their own indexed view. */
export type GeneratedInputNoticeDelta =
  | { kind: 'added'; notice: GeneratedAgentInputNotice }
  | { kind: 'dismissed'; id: string }

/** A client's view of one runtime's notices, rebuilt from ordered frames. Snapshot pages and
 *  live changes may interleave: overlapping chunks append once, a dismissal seen during the
 *  snapshot cannot be revived by an older page, and removal waits for the complete snapshot. */
export class GeneratedInputNoticeProjection {
  private session: string | null = null
  private readonly entries = new Map<string, Entry>()
  private snapshot: { token: number; seen: Set<string>; dismissed: Set<string> } | null = null
  private tokens = 0
  /** Bumped only when a notice becomes complete or a complete one goes; partial chunks don't. */
  private completeVersion = 0
  private synced = false
  // Changes since the last take: live completions and dismissals as deltas, or 'full' when the
  // view must be reconciled whole (a new session, a finished snapshot).
  private changes: GeneratedInputNoticeDelta[] | 'full' = 'full'

  /** A (re)subscription's ready message; a new runtime session discards the old view. */
  begin(session: string): number {
    if (session !== this.session) {
      this.entries.clear()
      this.session = session
      this.synced = false
      this.completeVersion += 1
      this.changes = 'full'
    }
    this.tokens += 1
    this.snapshot = { token: this.tokens, seen: new Set(), dismissed: new Set() }
    return this.tokens
  }

  /** A live frame, or a snapshot page's frame when `token` names the current snapshot. */
  applyFrame(session: string, frame: GeneratedInputNoticeFrame, token?: number): void {
    if (session !== this.session) {
      return
    }
    if (token !== undefined) {
      if (this.snapshot?.token !== token || this.snapshot.dismissed.has(frame.id)) {
        return
      }
    }
    this.snapshot?.seen.add(frame.id)
    let entry = this.entries.get(frame.id)
    if (!entry) {
      if (frame.offset !== 0) {
        return
      }
      entry = { frame, text: '' }
      this.entries.set(frame.id, entry)
    }
    const have = entry.text.length
    if (frame.offset <= have && frame.offset + frame.chunk.length > have) {
      entry.text += frame.chunk.slice(have - frame.offset)
      if (entry.text.length === entry.frame.textLength) {
        this.completed(entry, token)
      }
    } else if (have === 0 && frame.textLength === 0) {
      this.completed(entry, token)
    }
  }

  private completed(entry: Entry, token: number | undefined): void {
    this.completeVersion += 1
    // A page's notice is reconciled when its snapshot finishes; a live one is news on its own.
    if (token === undefined && this.changes !== 'full') {
      this.changes.push({ kind: 'added', notice: toNotice(entry) })
    }
  }

  dismiss(session: string, id: string): void {
    if (session !== this.session) {
      return
    }
    const entry = this.entries.get(id)
    if (entry) {
      this.entries.delete(id)
      this.completeVersion += 1
      // Only a notice consumers saw complete is news when it goes.
      if (this.changes !== 'full' && entry.text.length === entry.frame.textLength) {
        this.changes.push({ kind: 'dismissed', id })
      }
    }
    this.snapshot?.dismissed.add(id)
  }

  /** The last page arrived: anything neither paged nor added since is gone on the host. */
  finish(token: number): void {
    if (this.snapshot?.token !== token) {
      return
    }
    for (const id of this.entries.keys()) {
      if (!this.snapshot.seen.has(id)) {
        this.entries.delete(id)
        this.completeVersion += 1
      }
    }
    this.snapshot = null
    this.synced = true
    this.changes = 'full'
  }

  /** What consumers need since the last take: the whole complete view, or just its deltas. */
  takeChanges(): { full: GeneratedAgentInputNotice[] } | { deltas: GeneratedInputNoticeDelta[] } {
    const changes = this.changes
    this.changes = []
    return changes === 'full' ? { full: this.complete() } : { deltas: changes }
  }

  isCurrent(token: number): boolean {
    return this.snapshot?.token === token
  }

  /** Whether this session's first snapshot finished; before it the view is not yet the host's. */
  get isSynced(): boolean {
    return this.synced
  }

  get version(): number {
    return this.completeVersion
  }

  get currentSession(): string | null {
    return this.session
  }

  /** Notices whose exact text is complete; Copy never offers a partial prompt. */
  complete(): GeneratedAgentInputNotice[] {
    const notices: GeneratedAgentInputNotice[] = []
    for (const entry of this.entries.values()) {
      if (entry.text.length === entry.frame.textLength) {
        notices.push(toNotice(entry))
      }
    }
    return notices
  }
}

function toNotice({ frame, text }: Entry): GeneratedAgentInputNotice {
  const { textLength: _length, offset: _offset, chunk: _chunk, ...meta } = frame
  return { ...meta, text }
}
