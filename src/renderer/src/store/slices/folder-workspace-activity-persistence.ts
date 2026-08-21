type FolderWorkspaceActivityEntry = {
  lastPersistedAt: number
  pendingActivityAt: number | null
  timeout: ReturnType<typeof setTimeout> | null
}

export class FolderWorkspaceActivityPersistence {
  private readonly entries = new Map<string, FolderWorkspaceActivityEntry>()

  constructor(
    private readonly persist: (folderWorkspaceId: string, activityAt: number) => void,
    private readonly intervalMs: number
  ) {}

  record(folderWorkspaceId: string, activityAt: number): void {
    const now = Date.now()
    const existing = this.entries.get(folderWorkspaceId)
    if (!existing || now - existing.lastPersistedAt >= this.intervalMs) {
      if (existing?.timeout) {
        clearTimeout(existing.timeout)
      }
      this.entries.set(folderWorkspaceId, {
        lastPersistedAt: now,
        pendingActivityAt: null,
        timeout: null
      })
      this.persist(folderWorkspaceId, activityAt)
      return
    }

    existing.pendingActivityAt = activityAt
    if (existing.timeout) {
      return
    }
    existing.timeout = setTimeout(
      () => this.flush(folderWorkspaceId),
      this.intervalMs - (now - existing.lastPersistedAt)
    )
  }

  private flush(folderWorkspaceId: string): void {
    const entry = this.entries.get(folderWorkspaceId)
    if (!entry) {
      return
    }
    const activityAt = entry.pendingActivityAt
    entry.timeout = null
    entry.pendingActivityAt = null
    entry.lastPersistedAt = Date.now()
    if (activityAt !== null) {
      this.persist(folderWorkspaceId, activityAt)
    }
  }
}
