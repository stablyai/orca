import {
  gitHubTaskReadInstructions,
  gitHubTaskReadRowKey,
  type ReadBatch
} from './task-read-batches'
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

type ReadProgramContext = [
  current: readonly GitHubWorkItem[],
  program: readonly ReadBatch[],
  domains: ReadonlyMap<string, number>,
  pending: readonly GitHubWorkItem[] | undefined,
  ownedFields: ReadonlyMap<string, ReadonlySet<keyof GitHubWorkItem>>,
  borrowed: ReadonlySet<string>,
  borrowedRows: ReadonlyMap<string, GitHubWorkItem>
]
export function applyGitHubTaskReadProgram(
  items: GitHubWorkItem[],
  ...context: ReadProgramContext
): { items: GitHubWorkItem[]; adopted: Map<string, Set<keyof GitHubWorkItem>> }
export function applyGitHubTaskReadProgram(
  items: readonly GitHubWorkItem[],
  ...context: ReadProgramContext
): { items: readonly GitHubWorkItem[]; adopted: Map<string, Set<keyof GitHubWorkItem>> }
export function applyGitHubTaskReadProgram(
  items: readonly GitHubWorkItem[],
  current: readonly GitHubWorkItem[],
  program: readonly ReadBatch[],
  domains: ReadonlyMap<string, number>,
  pending: readonly GitHubWorkItem[] | undefined,
  ownedFields: ReadonlyMap<string, ReadonlySet<keyof GitHubWorkItem>>,
  borrowed: ReadonlySet<string>,
  borrowedRows: ReadonlyMap<string, GitHubWorkItem>
) {
  const adopted = new Map<string, Set<keyof GitHubWorkItem>>()
  const record = (
    before: ObservedGitHubWorkItem,
    after: ObservedGitHubWorkItem,
    direct = false
  ) => {
    if (before === after && !direct) {
      return
    }
    const fields = adopted.get(rowKey(after)) ?? new Set<keyof GitHubWorkItem>()
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
        (direct && field !== 'reviewRequests' && field !== 'autoMergeEnabled') ||
        before[field] !== after[field] ||
        (family && before.githubValueOrigins?.[family] !== after.githubValueOrigins?.[family])
      ) {
        fields.add(field)
      }
    }
    if (fields.size) {
      adopted.set(rowKey(after), fields)
    }
  }
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
    return { items, adopted }
  }
  const latest = new Map(current.map((row: ObservedGitHubWorkItem) => [rowKey(row), row]))
  let projection: ReturnType<typeof createTaskPageGitHubAuthorityProjection> | undefined
  const resultItems = items.map((row: ObservedGitHubWorkItem) => {
    let result = row
    const retiredFamilies = new Set<'assignees' | 'reviewRequests'>()
    const dependencies = new Set(
      ['assignees', 'reviewRequests'].filter((family) => borrowed.has(dependency(row, family)))
    )
    const instructionKey = gitHubTaskReadRowKey(row)
    for (const instruction of program.flatMap((batch) =>
      gitHubTaskReadInstructions(batch, instructionKey, domains)
    )) {
      const before = result
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
          (field) =>
            borrowedRows.has(rowKey(row)) ||
            ownedFields.get(rowKey(row))?.has(field) ||
            adopted.get(rowKey(row))?.has(field)
        )
        if (!fields.length) {
          continue
        }
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
        if (!dependencies.size) {
          continue
        }
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
      record(before, result, 'target' in instruction)
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
    record(row, result)
    return result
  })
  return { items: resultItems, adopted }
}
