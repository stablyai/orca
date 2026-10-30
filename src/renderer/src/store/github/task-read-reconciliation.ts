import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'
import {
  createTaskPageGitHubAuthorityProjection,
  createTaskPageGitHubListCompositionProgram
} from '@/components/task-page/github/task-page-github-work-item-mutation-composition'
import type {
  ListComposition,
  ListRetirement
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import {
  getGitHubTaskObservation,
  type ObservedGitHubWorkItem
} from '@/lib/github-task-observation'
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
  type ReadOperation,
  type ReadPatch,
  type ReadWrite,
  type GitHubTaskDeliveryWrite
} from './task-read-program'
import { materializeGitHubTaskDelivery } from './task-read-delivery'
export type { GitHubTaskDeliveryWrite } from './task-read-program'

const liveTaskReads = new Set<GitHubTaskRead>()
export type GitHubTaskRead = ReturnType<typeof beginGitHubTaskRead>
/** Marks live only through their final owner's commit; queued pure updaters keep their local marks. */
export function beginGitHubTaskRead(
  sources: readonly { repoId: string; path?: string; sourceContext?: TaskSourceContext | null }[],
  projectTarget?: RuntimeClientTarget,
  state?: Pick<AppState, 'repos'>
) {
  const { scopes, legacy, listDomains } = captureGitHubTaskReadDomains(sources, state)
  let program: ReadOperation[] = []
  const borrowed = new Set<string>()
  const borrowedRows = new Map<string, GitHubWorkItem>()
  let pending: GitHubWorkItem[] | undefined
  let publish: ((update: (current: GitHubWorkItem[]) => GitHubWorkItem[]) => void) | undefined
  let previous: GitHubWorkItem[] | undefined
  const ownedFields = new Map<string, Set<keyof GitHubWorkItem>>()
  let release: (() => void) | undefined
  let version = 0,
    settled = false,
    committed = 0
  const receive = (operation: ReadOperation) => {
    program = [...program, operation]
    if (pending && publish) {
      read.deliver(pending, publish)
    }
  }
  const read = {
    mark(target: RefreshTarget, item: GitHubWorkItem, body: string) {
      if (
        target.observations.some((owner) => owner && scopes.has(owner.key)) ||
        target.sources.some((source) =>
          legacy.has(JSON.stringify([target.item.repoId, githubTaskSourceKey(source)]))
        ) ||
        (projectTarget &&
          JSON.stringify(projectTarget) ===
            JSON.stringify(getGitHubSourceRuntimeTarget(target.source)))
      ) {
        receive({ target, item, body })
      }
    },
    retire(
      index: ReadonlyMap<string, readonly ListRetirement[]>,
      projection = createTaskPageGitHubAuthorityProjection()
    ) {
      for (const domain of listDomains) {
        const retirements = index.get(domain)
        if (retirements?.length) {
          receive({ retirements, projection })
        }
      }
    },
    assign(index: ReadonlyMap<string, readonly GitHubTaskDeliveryWrite[]>) {
      for (const domain of listDomains) {
        for (const write of index.get(domain) ?? []) {
          receive(write)
        }
      }
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
    write(index: ReadonlyMap<string, readonly ListComposition[]>, apply: ReadWrite['apply']) {
      for (const domain of listDomains) {
        const plans = index.get(domain)
        if (plans?.length) {
          receive({ plans, apply })
        }
      }
    },
    deliver(items: readonly GitHubWorkItem[], destination: NonNullable<typeof publish>) {
      const next = read.apply(items)
      for (const operation of program) {
        if ('target' in operation) {
          const key = rowKey(operation.item, operation.target.hostId)
          ownedFields.set(
            key,
            new Set([
              ...(ownedFields.get(key) ?? []),
              'title',
              'state',
              'labels',
              'assignees',
              'author',
              'authorAvatarUrl',
              'updatedAt'
            ])
          )
        }
      }
      for (let index = 0; index < next.length; index++) {
        const before: ObservedGitHubWorkItem = items[index],
          after: ObservedGitHubWorkItem = next[index]
        if (before === after) {
          continue
        }
        const fields = ownedFields.get(rowKey(after)) ?? new Set<keyof GitHubWorkItem>()
        for (const field of [
          'title',
          'state',
          'labels',
          'assignees',
          'author',
          'authorAvatarUrl',
          'updatedAt',
          'reviewRequests',
          'autoMergeEnabled'
        ] as const) {
          const family =
            field === 'autoMergeEnabled'
              ? 'autoMerge'
              : field === 'state' || field === 'assignees' || field === 'reviewRequests'
                ? field
                : undefined
          if (
            before[field] !== after[field] ||
            (family && before.githubValueOrigins?.[family] !== after.githubValueOrigins?.[family])
          ) {
            fields.add(field)
          }
        }
        ownedFields.set(rowKey(after), fields)
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
      return program.filter((p): p is ReadPatch => 'target' in p && p.target.current())
    },
    apply(
      items: readonly GitHubWorkItem[],
      current: readonly GitHubWorkItem[] = []
    ): GitHubWorkItem[] {
      return applyGitHubTaskReadProgram(
        items,
        current,
        program,
        pending,
        ownedFields,
        borrowed,
        borrowedRows
      )
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
  for (const read of liveTaskReads) {
    read.mark(target, item, body)
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
  for (const read of liveTaskReads) {
    read.retire(index, projection)
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
  for (const read of liveTaskReads) {
    read.write(index, apply)
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
  for (const read of liveTaskReads) {
    read.assign(index)
  }
}
