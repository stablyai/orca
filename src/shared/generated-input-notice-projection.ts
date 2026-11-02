import type {
  GeneratedAgentInputNotice,
  GeneratedInputNoticeFrame
} from './generated-agent-input-notice'

type Entry = { frame: GeneratedInputNoticeFrame; text: string }

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

  /** A (re)subscription's ready message; a new runtime session discards the old view. */
  begin(session: string): number {
    if (session !== this.session) {
      this.entries.clear()
      this.session = session
      this.synced = false
      this.completeVersion += 1
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
        this.completeVersion += 1
      }
    } else if (have === 0 && frame.textLength === 0) {
      this.completeVersion += 1
    }
  }

  dismiss(session: string, id: string): void {
    if (session !== this.session) {
      return
    }
    if (this.entries.delete(id)) {
      this.completeVersion += 1
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
    for (const { frame, text } of this.entries.values()) {
      if (text.length === frame.textLength) {
        const { textLength: _length, offset: _offset, chunk: _chunk, ...meta } = frame
        notices.push({ ...meta, text })
      }
    }
    return notices
  }
}
