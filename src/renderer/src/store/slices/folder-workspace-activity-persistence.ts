import type { ExecutionHostId } from '../../../../shared/execution-host'

type FolderWorkspaceActivityEntry = {
  target: FolderWorkspaceActivityTarget
  lastPersistedAt: number
  pendingActivityAt: number | null
  timeout: ReturnType<typeof setTimeout> | null
}

export type FolderWorkspaceActivityTarget = {
  folderWorkspaceId: string
  executionHostId: ExecutionHostId
}

export class FolderWorkspaceActivityPersistence {
  private readonly entries = new Map<string, FolderWorkspaceActivityEntry>()

  constructor(
    private readonly persist: (target: FolderWorkspaceActivityTarget, activityAt: number) => void,
    private readonly intervalMs: number
  ) {}

  record(target: FolderWorkspaceActivityTarget, activityAt: number): void {
    const now = Date.now()
    const key = `${target.folderWorkspaceId}\0${target.executionHostId}`
    const existing = this.entries.get(key)
    if (!existing || now - existing.lastPersistedAt >= this.intervalMs) {
      if (existing?.timeout) {
        clearTimeout(existing.timeout)
      }
      this.entries.set(key, {
        target,
        lastPersistedAt: now,
        pendingActivityAt: null,
        timeout: null
      })
      this.persist(target, activityAt)
      return
    }

    existing.pendingActivityAt = activityAt
    if (existing.timeout) {
      return
    }
    existing.timeout = setTimeout(
      () => this.flush(key),
      this.intervalMs - (now - existing.lastPersistedAt)
    )
  }

  private flush(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) {
      return
    }
    const activityAt = entry.pendingActivityAt
    entry.timeout = null
    entry.pendingActivityAt = null
    entry.lastPersistedAt = Date.now()
    if (activityAt !== null) {
      this.persist(entry.target, activityAt)
    }
  }
}
