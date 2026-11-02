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

  /** A (re)subscription's ready message; a new runtime session discards the old view. */
  begin(session: string): number {
    if (session !== this.session) {
      this.entries.clear()
      this.session = session
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
    }
  }

  dismiss(session: string, id: string): void {
    if (session !== this.session) {
      return
    }
    this.entries.delete(id)
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
      }
    }
    this.snapshot = null
  }

  isCurrent(token: number): boolean {
    return this.snapshot?.token === token
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
