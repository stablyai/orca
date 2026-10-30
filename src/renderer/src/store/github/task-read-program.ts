import {
  type createTaskPageGitHubAuthorityProjection,
  restoreTaskPageGitHubListOutput
} from '@/components/task-page/github/task-page-github-work-item-mutation-composition'
import { taskPageGitHubMutationItemId } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'
import {
  listInput,
  type ListComposition,
  type ListRetirement
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import {
  sameGitHubTaskObservation,
  patchObservedGitHubWorkItem,
  getGitHubTaskObservation,
  type ObservedGitHubWorkItem
} from '@/lib/github-task-observation'
import {
  githubTaskIdentity,
  githubTaskSourceKey,
  githubTaskContent,
  type captureGitHubTaskTarget
} from '@/lib/github-task-target'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

export type RefreshTarget = NonNullable<ReturnType<typeof captureGitHubTaskTarget>>
export type ReadPatch = { target: RefreshTarget; item: ObservedGitHubWorkItem; body: string }
export type ReadListProgram = {
  retirements: readonly ListRetirement[]
  projection: ReturnType<typeof createTaskPageGitHubAuthorityProjection>
}
export type ReadWrite = {
  plans: readonly ListComposition[]
  apply: (item: ObservedGitHubWorkItem) => ObservedGitHubWorkItem
}
export type GitHubTaskDeliveryWrite = {
  before: ObservedGitHubWorkItem
  after: ObservedGitHubWorkItem
  written: readonly (keyof GitHubWorkItem)[]
}
export type ReadOperation = ReadPatch | ReadListProgram | ReadWrite | GitHubTaskDeliveryWrite
export const rowKey = (row: GitHubWorkItem, host = row.repoHostId ?? '') =>
  `${row.repoId}\0${host}\0${githubTaskIdentity(row)}`
export const dependency = (row: ObservedGitHubWorkItem, family: string) =>
  `${rowKey(row)}\0${getGitHubTaskObservation(row)?.key ?? ''}\0${family}`

export function applyGitHubTaskReadProgram(
  items: readonly GitHubWorkItem[],
  current: readonly GitHubWorkItem[],
  program: readonly ReadOperation[],
  pending: readonly GitHubWorkItem[] | undefined,
  ownedFields: ReadonlyMap<string, ReadonlySet<keyof GitHubWorkItem>>,
  borrowed: ReadonlySet<string>,
  borrowedRows: ReadonlyMap<string, GitHubWorkItem>
): GitHubWorkItem[] {
  if (pending && items !== pending && ownedFields.size) {
    const index = new Map(pending.map((row: ObservedGitHubWorkItem) => [rowKey(row), row]))
    items = items.map((row: ObservedGitHubWorkItem) => {
      const owner = index.get(rowKey(row)),
        fields = ownedFields.get(rowKey(row))
      if (
        !owner ||
        !fields?.size ||
        !sameGitHubTaskObservation(getGitHubTaskObservation(owner), getGitHubTaskObservation(row))
      ) {
        return row
      }
      const origins: ObservedGitHubWorkItem['githubValueOrigins'] = {}
      for (const family of ['state', 'autoMerge', 'assignees', 'reviewRequests'] as const) {
        if (fields.has(family === 'autoMerge' ? 'autoMergeEnabled' : family)) {
          origins[family] = owner.githubValueOrigins?.[family]
        }
      }
      return patchObservedGitHubWorkItem(
        row,
        Object.fromEntries([...fields].map((field) => [field, owner[field]])),
        origins
      )
    })
  }
  if (!program.length) {
    return items as GitHubWorkItem[]
  } // SAFETY: callers never mutate the unchanged readonly array.
  const keyOf = (repoId: string, itemId: string) => `${repoId}\0${itemId}`
  const instructions = new Map<
    string,
    (
      | ReadPatch
      | (ListRetirement & {
          projection: ReturnType<typeof createTaskPageGitHubAuthorityProjection>
        })
      | ReadWrite
      | GitHubTaskDeliveryWrite
    )[]
  >()
  for (const operation of program) {
    if ('plans' in operation) {
      for (const { address } of operation.plans) {
        const key = keyOf(address.repoId, address.itemId)
        const group = instructions.get(key) ?? []
        if (!group.includes(operation)) {
          group.push(operation)
        }
        instructions.set(key, group)
      }
      continue
    }
    if ('before' in operation) {
      const key = keyOf(operation.before.repoId, taskPageGitHubMutationItemId(operation.before))
      const group = instructions.get(key) ?? []
      group.push(operation)
      instructions.set(key, group)
      continue
    }
    for (const instruction of 'retirements' in operation
      ? operation.retirements.map((retirement) => ({
          ...retirement,
          projection: operation.projection
        }))
      : [operation]) {
      const key =
        'target' in instruction
          ? keyOf(instruction.item.repoId, taskPageGitHubMutationItemId(instruction.item))
          : 'plans' in instruction
            ? ''
            : keyOf(instruction.address.repoId, instruction.address.itemId)
      const group = instructions.get(key) ?? []
      group.push(instruction)
      instructions.set(key, group)
    }
  }
  const latest = new Map(current.map((row: ObservedGitHubWorkItem) => [rowKey(row), row]))
  let projection: ReturnType<typeof createTaskPageGitHubAuthorityProjection> | undefined
  return items.map((row: ObservedGitHubWorkItem) => {
    let result = row
    const retiredFamilies = new Set<'assignees' | 'reviewRequests'>()
    const dependencies = new Set(
      ['assignees', 'reviewRequests'].filter((family) => borrowed.has(dependency(row, family)))
    )
    for (const instruction of instructions.get(
      keyOf(row.repoId, taskPageGitHubMutationItemId(row))
    ) ?? []) {
      if ('before' in instruction) {
        if (
          instruction.before.id !== row.id ||
          !sameGitHubTaskObservation(
            getGitHubTaskObservation(instruction.before),
            getGitHubTaskObservation(row)
          )
        ) {
          continue
        }
        const fields = instruction.written.filter(
          (field) => borrowedRows.has(rowKey(row)) || ownedFields.get(rowKey(row))?.has(field)
        )
        const origins: ObservedGitHubWorkItem['githubValueOrigins'] = {}
        for (const family of ['state', 'autoMerge', 'assignees', 'reviewRequests'] as const) {
          if (fields.includes(family === 'autoMerge' ? 'autoMergeEnabled' : family)) {
            origins[family] = instruction.after.githubValueOrigins?.[family]
          }
        }
        result = patchObservedGitHubWorkItem(
          result,
          Object.fromEntries(fields.map((field) => [field, instruction.after[field]])),
          origins
        )
      } else if ('plans' in instruction) {
        const composed = instruction.apply(result)
        for (const family of ['assignees', 'reviewRequests'] as const) {
          if (dependencies.has(family)) {
            result = patchObservedGitHubWorkItem(
              result,
              { [family]: composed[family] },
              { [family]: composed.githubValueOrigins?.[family] }
            )
          }
        }
      } else if ('target' in instruction) {
        const patch = instruction
        if (!patch.target.matches(row)) {
          continue
        }
        const candidate =
          latest.get(rowKey(row, patch.target.hostId)) ?? latest.get(rowKey(row, ''))
        const present =
          candidate &&
          (!getGitHubTaskObservation(candidate) ||
            patch.target.observations.some(
              (owner) => owner?.key === getGitHubTaskObservation(candidate)?.key
            )) &&
          patch.target.matches(candidate)
            ? candidate
            : patch.item
        result = patchObservedGitHubWorkItem(
          result,
          {
            ...githubTaskContent(present),
            githubObservation: getGitHubTaskObservation(present)
          },
          {
            state: present.githubValueOrigins?.state,
            assignees: present.githubValueOrigins?.assignees
          }
        )
      } else {
        const { address } = instruction
        projection = instruction.projection
        retiredFamilies.add(address.family)
        if (
          result.githubValueOrigins?.[address.family]?.listLifetime !== instruction.fromLifetime
        ) {
          continue
        }
        dependencies.add(address.family)
        const candidate =
          latest.get(rowKey(row, address.observation?.hostId)) ?? latest.get(rowKey(row, ''))
        result =
          candidate && listInput(candidate, address.family, address.observation).kind === 'full'
            ? patchObservedGitHubWorkItem(
                result,
                { [address.family]: candidate[address.family] },
                { [address.family]: candidate.githubValueOrigins?.[address.family] }
              )
            : restoreTaskPageGitHubListOutput(result, instruction)
      }
    }
    // Only dependent output participates; ordinary incoming provider rows stay raw.
    for (const family of retiredFamilies) {
      const origin = result.githubValueOrigins?.[family]
      if (origin?.listLifetime) {
        result = projection!.list(result, {
          address: {
            sourceScope: origin.owner ? githubTaskSourceKey(origin.owner.source) : null,
            repoId: result.repoId,
            itemId: taskPageGitHubMutationItemId(result),
            itemType: result.type,
            family,
            observation: origin.owner
          }
        })
      }
    }
    return result
  })
}
