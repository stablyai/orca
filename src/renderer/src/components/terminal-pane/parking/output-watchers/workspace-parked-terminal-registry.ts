/** Keep reverse ownership in the mutation API, including exit tombstones and captures written during unmount. */
export class WorkspaceParkedTerminalRegistry<T extends { worktreeId: string }> extends Map<
  string,
  T
> {
  private readonly tabIdsByWorktreeId = new Map<string, Set<string>>()

  constructor(
    private readonly changed?: (
      tabId: string,
      worktreeId: string,
      previous: T | undefined,
      next: T | undefined
    ) => void
  ) {
    super()
  }

  override set(tabId: string, entry: T): this {
    const previous = this.get(tabId)
    if (previous === entry) {
      return this
    }
    if (previous && previous.worktreeId !== entry.worktreeId) {
      this.delete(tabId)
    }
    let bucket = this.tabIdsByWorktreeId.get(entry.worktreeId)
    if (!bucket) {
      this.tabIdsByWorktreeId.set(entry.worktreeId, (bucket = new Set()))
    }
    bucket.add(tabId)
    super.set(tabId, entry)
    this.changed?.(tabId, entry.worktreeId, previous, entry)
    return this
  }

  override delete(tabId: string): boolean {
    const previous = this.get(tabId)
    if (!previous) {
      return false
    }
    super.delete(tabId)
    const bucket = this.tabIdsByWorktreeId.get(previous.worktreeId)
    bucket?.delete(tabId)
    if (bucket?.size === 0) {
      this.tabIdsByWorktreeId.delete(previous.worktreeId)
    }
    this.changed?.(tabId, previous.worktreeId, previous, undefined)
    return true
  }

  override clear(): void {
    for (const tabId of this.keys()) {
      this.delete(tabId)
    }
  }

  workspaceTabIds(worktreeId: string): Iterable<string> {
    return this.tabIdsByWorktreeId.get(worktreeId) ?? []
  }

  workspaceIds(): Iterable<string> {
    return this.tabIdsByWorktreeId.keys()
  }
}
