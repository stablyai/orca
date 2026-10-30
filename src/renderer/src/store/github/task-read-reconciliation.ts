import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'
import {
  createTaskPageGitHubAuthorityProjection,
  createTaskPageGitHubListCompositionProgram
} from '@/components/task-page/github/task-page-github-work-item-mutation-composition'
import type {
  ListComposition,
  ListRetirement
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { getGitHubTaskObservation } from '@/lib/github-task-observation'
import { githubTaskSourceKey } from '@/lib/github-task-target'
import { getGitHubSourceRuntimeTarget } from '@/lib/github-source-runtime-context'
import { captureGitHubTaskReadDomains } from './task-read-domains'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { AppState } from '../types'
import {
  applyGitHubTaskReadProgram,
  rowKey,
  dependency,
  type RefreshTarget,
  type ReadPatch,
  type GitHubTaskDeliveryWrite
} from './task-read-program'
import {
  prepareGitHubTaskReadBatch,
  gitHubTaskReadInstructions,
  gitHubTaskReadRowKey,
  type ReadBatch,
  type ReadIndex
} from './task-read-batches'
import { materializeGitHubTaskDelivery } from './task-read-delivery'
export type { GitHubTaskDeliveryWrite } from './task-read-program'

const liveTaskReads = new Set<GitHubTaskRead>()
export type GitHubTaskRead = ReturnType<typeof beginGitHubTaskRead>
/** Marks live only through their final owner's commit; queued pure updaters keep their local marks. */
export function beginGitHubTaskRead(
  sources: readonly { repoId: string; path?: string; sourceContext?: TaskSourceContext | null }[],
  projectTarget?: RuntimeClientTarget,
  state?: Pick<AppState, 'repos'>,
  destinationItems?: GitHubWorkItem[]
) {
  const { scopes, legacy, listDomains } = captureGitHubTaskReadDomains(sources, state)
  let program: ReadBatch[] = []
  const domains = new Map([...listDomains].map((domain, order) => [domain, order]))
  domains.set('*', -1)
  const borrowed = new Set<string>()
  const borrowedRows = new Map<string, GitHubWorkItem>()
  let pending: GitHubWorkItem[] | undefined
  let publish: ((update: (current: GitHubWorkItem[]) => GitHubWorkItem[]) => void) | undefined
  let previous = destinationItems
  const ownedFields = new Map<string, Set<keyof GitHubWorkItem>>()
  let release: (() => void) | undefined
  let version = 0,
    settled = false,
    committed = 0
  const receive = (batch: ReadBatch) => {
    if (![...domains.keys()].some((domain) => batch.domains.has(domain))) {
      return
    }
    program.push(batch)
    if (
      pending &&
      publish &&
      pending.some(
        (row) => gitHubTaskReadInstructions(batch, gitHubTaskReadRowKey(row), domains).length
      )
    ) {
      const evaluated = applyGitHubTaskReadProgram(
        pending,
        [],
        program,
        domains,
        pending,
        ownedFields,
        borrowed,
        borrowedRows
      )
      if (!evaluated.adopted.size && evaluated.items.every((row, i) => row === pending![i])) {
        return
      }
      read.deliver(pending, publish, evaluated)
    }
  }
  const read = {
    mark(
      target: RefreshTarget,
      item: GitHubWorkItem,
      body: string,
      batch = prepareGitHubTaskReadBatch([['*', [{ target, item, body }]]])
    ) {
      if (
        target.observations.some((owner) => owner && scopes.has(owner.key)) ||
        target.sources.some((source) =>
          legacy.has(JSON.stringify([target.item.repoId, githubTaskSourceKey(source)]))
        ) ||
        (projectTarget &&
          JSON.stringify(projectTarget) ===
            JSON.stringify(getGitHubSourceRuntimeTarget(target.source)))
      ) {
        receive(batch)
      }
    },
    retire(
      index: ReadIndex<ListRetirement>,
      projection = createTaskPageGitHubAuthorityProjection()
    ) {
      receive(
        index.batch ??
          prepareGitHubTaskReadBatch(
            [...index].map(([domain, retirements]) => [domain, [{ retirements, projection }]])
          )
      )
    },
    assign(index: ReadIndex<GitHubTaskDeliveryWrite>) {
      receive(index.batch ?? prepareGitHubTaskReadBatch(index))
    },
    borrow(items: readonly GitHubWorkItem[]) {
      for (const item of items) {
        if (!borrowedRows.has(rowKey(item))) {
          borrowedRows.set(rowKey(item), item)
        }
        for (const family of ['assignees', 'reviewRequests']) {
          borrowed.add(dependency(item, family))
        }
      }
    },
    write(index: ReadIndex<ListComposition>, apply: (item: GitHubWorkItem) => GitHubWorkItem) {
      receive(
        index.batch ??
          prepareGitHubTaskReadBatch(
            [...index].map(([domain, plans]) => [domain, [{ plans, apply }]])
          )
      )
    },
    deliver(
      items: readonly GitHubWorkItem[],
      destination: NonNullable<typeof publish>,
      evaluated = applyGitHubTaskReadProgram(
        items,
        [],
        program,
        domains,
        pending,
        ownedFields,
        borrowed,
        borrowedRows
      )
    ) {
      const next = evaluated.items
      for (const [key, fields] of evaluated.adopted) {
        const owned = ownedFields.get(key) ?? new Set<keyof GitHubWorkItem>()
        for (const field of fields) {
          owned.add(field)
        }
        ownedFields.set(key, owned)
      }
      program = []
      pending = next
      publish = destination
      const prior = previous
      previous = next
      const publication = ++version
      const dependencies = new Set(borrowed)
      const previousRows = prior
        ? new Map(prior.map((row) => [rowKey(row), row]))
        : new Map(borrowedRows)
      const fields = new Map([...ownedFields].map(([key, fields]) => [key, new Set(fields)]))
      destination(
        Object.assign(
          (current: GitHubWorkItem[]) =>
            materializeGitHubTaskDelivery(current, next, prior, previousRows, fields, dependencies),
          {
            commit: () => {
              committed = Math.max(committed, publication)
              if (settled && committed === version) {
                read.dispose()
              }
            }
          }
        )
      )
    },
    finish(onRelease?: () => void) {
      release = onRelease
      settled = true
      if (!publish || committed === version) {
        read.dispose()
      }
    },
    projectPatches() {
      return program
        .flatMap((batch) => batch.patches)
        .filter((p): p is ReadPatch => p.target.current())
    },
    apply(
      items: readonly GitHubWorkItem[],
      current: readonly GitHubWorkItem[] = []
    ): GitHubWorkItem[] {
      return applyGitHubTaskReadProgram(
        items,
        current,
        program,
        domains,
        pending,
        ownedFields,
        borrowed,
        borrowedRows
      ).items
    },
    dispose() {
      liveTaskReads.delete(read)
      pending = undefined
      publish = undefined
      const released = release
      release = undefined
      released?.()
    }
  }
  liveTaskReads.add(read)
  return read
}
export function markGitHubTaskReads(target: RefreshTarget, item: GitHubWorkItem, body: string) {
  const batch = prepareGitHubTaskReadBatch([['*', [{ target, item, body }]]])
  for (const read of liveTaskReads) {
    read.mark(target, item, body, batch)
  }
}

export function markGitHubTaskListRetirements(retirements: readonly ListRetirement[]) {
  const index = new Map<string, ListRetirement[]>()
  for (const retirement of retirements) {
    const { address } = retirement
    const key = JSON.stringify([address.repoId, address.sourceScope])
    const group = index.get(key) ?? []
    group.push(retirement)
    index.set(key, group)
  }
  const projection = createTaskPageGitHubAuthorityProjection()
  const prepared = Object.assign(index, {
    batch: prepareGitHubTaskReadBatch(
      [...index].map(([domain, retirements]) => [domain, [{ retirements, projection }]])
    )
  })
  for (const read of liveTaskReads) {
    read.retire(prepared, projection)
  }
  taskPageGitHubResumeCache.patch(
    () => true,
    createTaskPageGitHubListCompositionProgram(
      retirements.map((retirement) => ({ address: retirement.address, retirement }))
    )
  )
}

export function markGitHubTaskListWrites(plans: readonly ListComposition[]) {
  if (!plans.length) {
    return
  }
  const index = new Map<string, ListComposition[]>()
  for (const plan of plans) {
    const key = JSON.stringify([plan.address.repoId, plan.address.sourceScope])
    const group = index.get(key) ?? []
    group.push(plan)
    index.set(key, group)
  }
  const apply = createTaskPageGitHubListCompositionProgram(plans)
  const prepared = Object.assign(index, {
    batch: prepareGitHubTaskReadBatch(
      [...index].map(([domain, plans]) => [domain, [{ plans, apply }]])
    )
  })
  for (const read of liveTaskReads) {
    read.write(prepared, apply)
  }
}

export function markGitHubTaskDeliveryWrites(writes: readonly GitHubTaskDeliveryWrite[]) {
  if (!writes.length) {
    return
  }
  const index = new Map<string, GitHubTaskDeliveryWrite[]>()
  for (const write of writes) {
    const owner = getGitHubTaskObservation(write.after)
    const key = JSON.stringify([
      write.after.repoId,
      owner ? githubTaskSourceKey(owner.source) : null
    ])
    const group = index.get(key) ?? []
    group.push(write)
    index.set(key, group)
  }
  const prepared = Object.assign(index, { batch: prepareGitHubTaskReadBatch(index) })
  for (const read of liveTaskReads) {
    read.assign(prepared)
  }
}
