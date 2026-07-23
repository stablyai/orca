export const GITHUB_WORK_ITEM_FETCH_CONCURRENCY = 8
export const GITHUB_WORK_ITEM_FETCH_MAX_WAITERS = 256
const GITHUB_WORK_ITEM_FETCH_WAITER_COMPACTION_HEAD = 64

export class GitHubWorkItemRequestSlots {
  private active = 0
  private readonly waiters: ((() => void) | undefined)[] = []
  private waiterHead = 0

  constructor(
    private readonly concurrency = GITHUB_WORK_ITEM_FETCH_CONCURRENCY,
    private readonly maxWaiters = GITHUB_WORK_ITEM_FETCH_MAX_WAITERS
  ) {}

  async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1
      return
    }
    if (this.waiters.length - this.waiterHead >= this.maxWaiters) {
      throw new Error('GitHub work-item request queue is full; retry after active requests finish.')
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters[this.waiterHead]
    if (next) {
      this.waiters[this.waiterHead] = undefined
      this.waiterHead += 1
      if (this.waiterHead >= GITHUB_WORK_ITEM_FETCH_WAITER_COMPACTION_HEAD) {
        this.waiters.splice(0, this.waiterHead)
        this.waiterHead = 0
      }
      next()
      return
    }
    this.waiters.length = 0
    this.waiterHead = 0
    this.active = Math.max(0, this.active - 1)
  }
}
