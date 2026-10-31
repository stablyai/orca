import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { githubTaskIdentity } from '@/lib/github-task-target'
import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/github-work-item-source-lookup'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { nextProviderRequestId } from './request-coordination'
import {
  applyTaskChange,
  composeTaskChanges,
  publishTaskChange,
  untrackedTaskOperation,
  type TaskChange
} from './task-change'
import {
  connection,
  contribute,
  sameFacts,
  sources,
  version,
  type AcceptedTask,
  type TaskBinding
} from './task-record-model'
import { TaskRecordOwners } from './task-record-owners'

/** Search deliveries, edits and the one canonical read lane of each owner. */
export abstract class TaskRecordReads extends TaskRecordOwners {
  acceptSearch(
    rows: readonly GitHubWorkItem[],
    binding: TaskBinding | undefined
  ): readonly GitHubWorkItem[] {
    const stored = rows.map((item) => {
      const record = binding && this.record(item, binding)
      if (!record) {
        return item
      }
      // Search can't prove it includes an unverified edit, so an owner without a base never adopts it.
      if (
        record.base &&
        !record.needsRead &&
        !record.pending.size &&
        Number.isFinite(version(item)) &&
        version(item) > version(record.base)
      ) {
        // A newer search row for a complete field family is the newest reading; unknown assignees stay owed.
        record.needsRead = item.assignees === undefined && record.base.assignees !== undefined
        this.accept(
          record,
          item.assignees === undefined ? { ...item, assignees: record.base.assignees } : item
        )
        this.emit(record)
      } else if (
        record.base &&
        !sameFacts(item, record.base) &&
        (record.needsRead ||
          !Number.isFinite(version(item)) ||
          !Number.isFinite(version(record.base)) ||
          version(item) >= version(record.base))
      ) {
        record.needsRead = true
      }
      // A first owed read runs now; one that already failed waits for its turn below. The caller stores
      // the row, so it carries no pending change.
      if (record.needsRead && record.failedAt === undefined) {
        void this.verify(record)
      }
      return this.stored(item, record)
    })
    if (binding && this.current(binding)) {
      this.wake(binding.incarnation)
    }
    return stored
  }
  /** Each external delivery retries at most one owed read per binding, the longest-waiting first. */
  protected wake(incarnation: object) {
    let next: AcceptedTask | undefined
    for (const record of this.records.values()) {
      if (
        record.binding.incarnation === incarnation &&
        record.needsRead &&
        !record.pending.size &&
        !record.read &&
        (!next || (record.failedAt ?? 0) < (next.failedAt ?? 0))
      ) {
        next = record
      }
    }
    if (next) {
      void this.verify(next)
    }
  }
  /** A live record keeps tracking its started edits even after its server proves unsupported. */
  canTrack(binding: TaskBinding, item?: GitHubWorkItem) {
    return (
      !!(item && this.record(item, binding)) ||
      (this.current(binding) && !this.unsupported(binding))
    )
  }
  /** Settle returns the caller's item with the owner's surviving changes (or the accepted value). */
  operation(
    item: GitHubWorkItem,
    binding: TaskBinding,
    change: TaskChange
  ): (success: boolean) => GitHubWorkItem {
    if (item.type !== 'issue' || !this.canTrack(binding, item)) {
      const associations = binding.observation.associations.map(({ source }) => source)
      return untrackedTaskOperation(this.store, item, change, associations)
    }
    const record = this.remember(item, binding)
    const token = {}
    record.pending.set(token, change)
    record.revision = nextProviderRequestId()
    this.emit(record)
    const value = () => record.visible ?? contribute(item, record)
    let settled = false
    return (success: boolean) => {
      if (settled) {
        return value()
      }
      settled = true
      const live = this.record(item, record.binding) === record
      record.pending.delete(token)
      record.revision = nextProviderRequestId()
      if (success) {
        // A newly settled write is owed its own first read, whatever an earlier read's outcome was.
        record.needsRead = true
        record.failedAt = undefined
        if (record.base) {
          record.base = applyTaskChange(record.base, change)
        } else {
          // No accepted reading yet: copies take only this change, and it stays owed until one arrives.
          record.confirmed = composeTaskChanges(record.confirmed, change)
        }
      }
      // Stored copies never held this pending change: a failure only drops its token, and a success
      // applies just its own change to each copy's current value.
      if (!live) {
        // Disposed mid-flight: the owner still settles through its reducer, and a replacement record
        // reconciles through its own canonical read.
        record.visible = record.base && contribute(record.base, record)
        const replacement = this.records.get(this.key(item, binding.observation.hostId))
        if (replacement && this.current(replacement.binding)) {
          replacement.needsRead = true
          void this.verify(replacement)
        } else if (success) {
          publishTaskChange(this.store, item, change, sources(record))
        }
        return value()
      }
      if (success) {
        publishTaskChange(this.store, item, change, sources(record))
      }
      this.retire(record)
      this.emit(record)
      if (this.unsupported(record.binding) && !record.pending.size) {
        // A server without the item route keeps no unresolved record once its last edit settles.
        this.records.delete(this.key(item, binding.observation.hostId))
      } else if (record.needsRead && record.failedAt === undefined) {
        void this.verify(record)
      }
      return value()
    }
  }
  isPending(item: GitHubWorkItem, binding: TaskBinding) {
    return !!this.record(item, binding)?.pending.size
  }
  readRevision(item: GitHubWorkItem, binding: TaskBinding) {
    return this.record(item, binding)?.revision ?? 0
  }
  protected verify(record: AcceptedTask): Promise<boolean> {
    if (!this.current(record.binding) || record.pending.size) {
      return Promise.resolve(false)
    }
    if (record.read) {
      // A Refresh read serves this obligation; if it doesn't publish, its completion owes one item read.
      return record.read.light ? record.read.promise : Promise.resolve(false)
    }
    const item = record.base ?? record.address
    return this.readCanonical(
      item,
      record.binding,
      (accepts) => this.itemRead(item.url, record.binding, accepts),
      true
    )
  }
  protected async itemRead(url: string, binding: TaskBinding, accepts: () => boolean) {
    const { repoId, hostId, source } = binding.observation
    const repo = this.repo(repoId, hostId)
    const link = parseGitHubIssueOrPRLink(url)
    if (!repo || !link) {
      return null
    }
    return lookupGitHubWorkItemByOwnerRepoForSource({
      repoPath: repo.path,
      repoId: repo.id,
      sourceContext: source,
      accepts,
      ...link.slug,
      number: link.number,
      type: link.type
    })
  }
  /** The one lane that establishes or replaces a record's base; it never installs the caller's item. */
  async readCanonical(
    item: GitHubWorkItem,
    binding: TaskBinding,
    load: (accepts: () => boolean) => Promise<GitHubWorkItem | null>,
    light = false
  ): Promise<boolean> {
    // Admission is re-entered after every wait: the owner this read queued behind may have retired,
    // been replaced, or lost its binding or server support meanwhile.
    const admit = () =>
      item.type === 'issue' && this.canTrack(binding) ? this.remember(item, binding) : undefined
    let owner = admit()
    // A full conversation read waits for the existing item read.
    while (owner?.read) {
      await owner.read.promise
      owner = admit()
    }
    if (!owner || owner.pending.size) {
      return false
    }
    const record = owner
    const revision = record.revision,
      readOrder = nextProviderRequestId()
    const attempt = { revision, light, promise: Promise.resolve(false) }
    const accepts = () =>
      this.record(item, binding) === record &&
      record.revision === revision &&
      record.read === attempt &&
      !record.pending.size
    record.read = attempt
    attempt.promise = (async () => {
      try {
        const result = await load(accepts)
        if (!accepts()) {
          return false
        }
        if (
          !result ||
          result.type !== item.type ||
          result.number !== item.number ||
          githubTaskIdentity(result) !== githubTaskIdentity(item) ||
          result.assignees === undefined ||
          (Number.isFinite(version(record.base)) &&
            (!Number.isFinite(version(result)) || version(result) < version(record.base)))
        ) {
          // Unusable is not a reading: keep what is known and park an owed read until an external delivery.
          if (record.needsRead) {
            record.failedAt = nextProviderRequestId()
          }
          return false
        }
        // This reading was captured after every confirmed edit settled, so it covers them.
        this.accept(record, { ...item, ...result })
        record.confirmed = undefined
        record.readOrder = readOrder
        record.needsRead = false
        record.failedAt = undefined
        this.emit(record)
        return true
      } catch (error) {
        const { hostId, repoId, fence } = binding.observation
        const entry = this.bindings.get(`${hostId}\0${repoId}`)
        if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
          // Only the connection that answered lacks the route; a late old answer says nothing new.
          if (entry && this.current(binding)) {
            entry.unsupported = connection(fence)
            // Records with edits in flight stay until those settle; a confirmed change is already on the
            // copies, so idle records simply retire.
            for (const [key, owner] of this.records) {
              if (owner.binding.incarnation === binding.incarnation && !owner.pending.size) {
                this.records.delete(key)
              }
            }
            this.notify()
          }
        } else if (accepts() && record.needsRead) {
          record.failedAt = nextProviderRequestId()
        }
        return false
      } finally {
        if (record.read === attempt) {
          record.read = undefined
        }
        // A write that crossed this read, or a Refresh that didn't publish, leaves one item read owed.
        if (
          (record.revision !== revision || !light) &&
          record.needsRead &&
          !record.pending.size &&
          this.record(item, binding) === record
        ) {
          void this.verify(record)
        }
        // A failed first Refresh with nothing else owed leaves no record behind.
        if (this.retire(record)) {
          this.notify()
        }
      }
    })()
    return attempt.promise
  }
}
