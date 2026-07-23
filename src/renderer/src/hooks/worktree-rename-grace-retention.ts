import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

export const WORKTREE_RENAME_GRACE_MAX_ENTRIES = 4096
export const WORKTREE_RENAME_GRACE_MAX_ID_UTF8_BYTES = 64 * 1024
export const WORKTREE_RENAME_GRACE_MAX_TOTAL_ID_UTF8_BYTES = 8 * 1024 * 1024

type RetainedRenameId = {
  expiresAt: number
  idBytes: number
}

type WorktreeRenameGraceBounds = {
  maxEntries: number
  maxIdBytes: number
  maxTotalIdBytes: number
}

const DEFAULT_BOUNDS: WorktreeRenameGraceBounds = {
  maxEntries: WORKTREE_RENAME_GRACE_MAX_ENTRIES,
  maxIdBytes: WORKTREE_RENAME_GRACE_MAX_ID_UTF8_BYTES,
  maxTotalIdBytes: WORKTREE_RENAME_GRACE_MAX_TOTAL_ID_UTF8_BYTES
}

export class WorktreeRenameGraceRetention {
  private readonly entries = new Map<string, RetainedRenameId>()
  private retainedIdBytes = 0
  private suppressAllUntil = Number.NEGATIVE_INFINITY
  private sweepTimer: ReturnType<typeof setTimeout> | null = null
  private sweepDueAt = Number.POSITIVE_INFINITY

  constructor(
    private readonly bounds: WorktreeRenameGraceBounds = DEFAULT_BOUNDS,
    private readonly now: () => number = Date.now
  ) {}

  remember(ids: readonly string[], expiresAt: number): void {
    const now = this.now()
    this.sweepExpired(now)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return
    }
    for (const id of ids) {
      const measured = measureUtf8ByteLength(id, {
        stopAfterBytes: this.bounds.maxIdBytes
      })
      const previous = this.entries.get(id)
      if (previous) {
        previous.expiresAt = Math.max(previous.expiresAt, expiresAt)
        continue
      }
      if (
        id.length === 0 ||
        measured.exceededLimit ||
        this.entries.size >= this.bounds.maxEntries ||
        this.retainedIdBytes + measured.byteLength > this.bounds.maxTotalIdBytes
      ) {
        // Why: overload must defer destructive purge rather than misclassify an unretained rename as deletion.
        this.suppressAllUntil = Math.max(this.suppressAllUntil, expiresAt)
        continue
      }
      this.entries.set(id, { expiresAt, idBytes: measured.byteLength })
      this.retainedIdBytes += measured.byteLength
    }
    this.scheduleSweep()
  }

  protects(id: string, now = this.now()): boolean {
    this.sweepExpired(now)
    if (this.suppressAllUntil > now) {
      return true
    }
    return (this.entries.get(id)?.expiresAt ?? Number.NEGATIVE_INFINITY) > now
  }

  evidence(): { entries: number; idBytes: number; suppressAllUntil?: number } {
    return {
      entries: this.entries.size,
      idBytes: this.retainedIdBytes,
      ...(Number.isFinite(this.suppressAllUntil) ? { suppressAllUntil: this.suppressAllUntil } : {})
    }
  }

  dispose(): void {
    if (this.sweepTimer !== null) {
      clearTimeout(this.sweepTimer)
    }
    this.sweepTimer = null
    this.sweepDueAt = Number.POSITIVE_INFINITY
    this.entries.clear()
    this.retainedIdBytes = 0
    this.suppressAllUntil = Number.NEGATIVE_INFINITY
  }

  private sweepExpired(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt > now) {
        continue
      }
      this.entries.delete(id)
      this.retainedIdBytes -= entry.idBytes
    }
    if (this.suppressAllUntil <= now) {
      this.suppressAllUntil = Number.NEGATIVE_INFINITY
    }
  }

  private scheduleSweep(): void {
    let dueAt = Number.isFinite(this.suppressAllUntil)
      ? this.suppressAllUntil
      : Number.POSITIVE_INFINITY
    for (const entry of this.entries.values()) {
      dueAt = Math.min(dueAt, entry.expiresAt)
    }
    if (!Number.isFinite(dueAt) || (this.sweepTimer !== null && this.sweepDueAt <= dueAt)) {
      return
    }
    if (this.sweepTimer !== null) {
      clearTimeout(this.sweepTimer)
    }
    this.sweepDueAt = dueAt
    this.sweepTimer = setTimeout(
      () => {
        this.sweepTimer = null
        this.sweepDueAt = Number.POSITIVE_INFINITY
        this.sweepExpired(this.now())
        this.scheduleSweep()
      },
      Math.max(0, dueAt - this.now())
    )
  }
}

export const recentlyRenamedWorktreeGrace = new WorktreeRenameGraceRetention()
