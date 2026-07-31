import type { DirectSshWorktreeRefreshLogicalTask } from './direct-ssh-worktree-refresh-scheduler-types'

export class DirectSshWorktreeRefreshTargetQueue {
  private readonly queuedByTarget = new Map<string, DirectSshWorktreeRefreshLogicalTask[]>()
  private readonly targetOrder: string[] = []

  enqueue(task: DirectSshWorktreeRefreshLogicalTask, retrying: boolean, now: number): void {
    task.state = retrying ? 'retrying' : 'queued'
    task.queuedAt = now
    const lane = this.queuedByTarget.get(task.key.targetId)
    if (lane) {
      lane.push(task)
      return
    }
    this.queuedByTarget.set(task.key.targetId, [task])
    this.targetOrder.push(task.key.targetId)
  }

  takeNext(): DirectSshWorktreeRefreshLogicalTask | null {
    while (this.targetOrder.length > 0) {
      const targetId = this.targetOrder.shift()!
      const lane = this.queuedByTarget.get(targetId)
      const task = lane?.shift()
      if (!lane || !task) {
        this.queuedByTarget.delete(targetId)
        continue
      }
      if (lane.length > 0) {
        this.targetOrder.push(targetId)
      } else {
        this.queuedByTarget.delete(targetId)
      }
      if (task.state !== 'terminal' && task.waiters.size > 0) {
        return task
      }
    }
    return null
  }

  clear(): void {
    this.queuedByTarget.clear()
    this.targetOrder.length = 0
  }
}
