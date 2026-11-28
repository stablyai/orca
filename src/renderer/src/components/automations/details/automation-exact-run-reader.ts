import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import type { AutomationRunRead } from '../hosts/automation-owner-reads'

type FollowUp = {
  version: number
  promise: Promise<AutomationRunRead>
  resolve: (result: AutomationRunRead) => void
}
type Read = { version: number; promise: Promise<AutomationRunRead>; next?: FollowUp }

export class AutomationExactRunReader {
  private readonly reads = new Map<string, Read>()

  constructor(
    private readonly read: (owner: AutomationOwnerRef, runId: string) => Promise<AutomationRunRead>
  ) {}

  request(owner: AutomationOwnerRef, runId: string, version: number): Promise<AutomationRunRead> {
    const key = JSON.stringify([owner, runId])
    const current = this.reads.get(key)
    if (current) {
      if (version <= current.version) {
        return current.promise
      }
      if (!current.next) {
        let resolve!: FollowUp['resolve']
        const promise = new Promise<AutomationRunRead>((done) => {
          resolve = done
        })
        current.next = { version, promise, resolve }
      }
      current.next.version = Math.max(version, current.next.version)
      return current.next.promise
    }
    if (this.reads.size >= 128) {
      return Promise.resolve({ kind: 'error', error: new Error('Too many automation run reads.') })
    }
    const promise = Promise.resolve()
      .then(() => this.read(owner, runId))
      .catch((error: unknown): AutomationRunRead => ({ kind: 'error', error }))
    const entry: Read = { version, promise }
    this.reads.set(key, entry)
    void promise.then(() => {
      this.reads.delete(key)
      if (entry.next) {
        void this.request(owner, runId, entry.next.version).then(entry.next.resolve)
      }
    })
    return promise
  }
}
