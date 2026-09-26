/**
 * How long each repository's each maintenance task stays off the table.
 *
 * Keyed per task, not per repository: a ref backlog that packed cleanly is quiet
 * for twelve hours, and reading that as "this repository needs nothing" would
 * silence the object task for the same twelve hours on a repository that is
 * filling with loose objects the whole time.
 */
export class RepoMaintenanceCooldowns {
  private readonly until = new Map<string, number>()

  constructor(
    private readonly now: () => number,
    private readonly max: number
  ) {}

  isCoolingDown(key: string, taskId: string): boolean {
    const until = this.until.get(cooldownKey(key, taskId))
    return until !== undefined && this.now() < until
  }

  start(key: string, taskId: string, cooldownMs: number): void {
    const entry = cooldownKey(key, taskId)
    // Re-insert so Map order stays newest-last and the eviction below drops the oldest.
    this.until.delete(entry)
    if (cooldownMs <= 0) {
      return
    }
    this.until.set(entry, this.now() + cooldownMs)
    if (this.until.size > this.max) {
      const oldest = this.until.keys().next()
      if (!oldest.done) {
        this.until.delete(oldest.value)
      }
    }
  }

  clear(): void {
    this.until.clear()
  }
}

function cooldownKey(key: string, taskId: string): string {
  return `${key}::task:${taskId}`
}
