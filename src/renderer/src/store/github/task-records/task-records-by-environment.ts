import type { AcceptedTask } from './task-record-model'

function runtimeEnvironmentOf(record: AcceptedTask): string | null {
  const { target } = record.binding.observation.fence.route
  return target.kind === 'environment' ? target.environmentId : null
}

/** Task records, indexed by the paired runtime their fence routes through (nested SSH included). */
export class TaskRecordsByEnvironment extends Map<string, AcceptedTask> {
  private keysByEnvironment = new Map<string, Set<string>>()
  // Where each key was indexed, so a record rebound in place is removed from its old runtime.
  private environmentByKey = new Map<string, string>()

  override set(key: string, record: AcceptedTask): this {
    this.unindex(key)
    super.set(key, record)
    const environmentId = runtimeEnvironmentOf(record)
    if (environmentId !== null) {
      const keys = this.keysByEnvironment.get(environmentId) ?? new Set<string>()
      keys.add(key)
      this.keysByEnvironment.set(environmentId, keys)
      this.environmentByKey.set(key, environmentId)
    }
    return this
  }

  override delete(key: string): boolean {
    this.unindex(key)
    return super.delete(key)
  }

  override clear(): void {
    this.keysByEnvironment.clear()
    this.environmentByKey.clear()
    super.clear()
  }

  keysOn(environmentIds: Iterable<string>): string[] {
    return [...environmentIds].flatMap((id) => [...(this.keysByEnvironment.get(id) ?? [])])
  }

  private unindex(key: string): void {
    const environmentId = this.environmentByKey.get(key)
    if (environmentId === undefined) {
      return
    }
    this.environmentByKey.delete(key)
    const keys = this.keysByEnvironment.get(environmentId)
    keys?.delete(key)
    if (keys?.size === 0) {
      this.keysByEnvironment.delete(environmentId)
    }
  }
}
