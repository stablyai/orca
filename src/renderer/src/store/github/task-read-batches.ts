import { taskPageGitHubMutationItemId } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type {
  ReadOperation,
  ReadPatch,
  ReadWrite,
  ReadListProgram,
  GitHubTaskDeliveryWrite
} from './task-read-program'

export type ReadInstruction =
  | ReadPatch
  | ReadWrite
  | GitHubTaskDeliveryWrite
  | (ReadListProgram['retirements'][number] & { projection: ReadListProgram['projection'] })
export type ReadBatch = Readonly<{
  domains: ReadonlySet<string>
  rows: ReadonlyMap<string, ReadonlyMap<string, readonly ReadInstruction[]>>
  patches: readonly ReadPatch[]
}>
export type ReadIndex<T> = ReadonlyMap<string, readonly T[]> & { batch?: ReadBatch }
const keyOf = (repoId: string, itemId: string) => `${repoId}\0${itemId}`

/** Compile the invocation once; every finite read retains the same immutable instructions. */
export function prepareGitHubTaskReadBatch(
  groups: Iterable<readonly [string, readonly ReadOperation[]]>
): ReadBatch {
  const domains = new Set<string>()
  const rows = new Map<string, Map<string, ReadInstruction[]>>()
  const patches: ReadPatch[] = []
  const append = (domain: string, repoId: string, itemId: string, instruction: ReadInstruction) => {
    const key = keyOf(repoId, itemId)
    let row = rows.get(key)
    if (!row) {
      rows.set(key, (row = new Map()))
    }
    let group = row.get(domain)
    if (!group) {
      row.set(domain, (group = []))
    }
    group.push(instruction)
  }
  for (const [domain, operations] of groups) {
    domains.add(domain)
    for (const operation of operations) {
      if ('plans' in operation) {
        const seen = new Set<string>()
        for (const { address } of operation.plans) {
          const key = keyOf(address.repoId, address.itemId)
          if (!seen.has(key)) {
            seen.add(key)
            append(domain, address.repoId, address.itemId, operation)
          }
        }
      } else if ('before' in operation) {
        append(
          domain,
          operation.before.repoId,
          taskPageGitHubMutationItemId(operation.before),
          operation
        )
      } else if ('target' in operation) {
        patches.push(operation)
        append(
          domain,
          operation.item.repoId,
          taskPageGitHubMutationItemId(operation.item),
          operation
        )
      } else {
        for (const retirement of operation.retirements) {
          append(domain, retirement.address.repoId, retirement.address.itemId, {
            ...retirement,
            projection: operation.projection
          })
        }
      }
    }
  }
  return { domains, rows, patches }
}

export const gitHubTaskReadRowKey = (row: GitHubWorkItem) =>
  keyOf(row.repoId, taskPageGitHubMutationItemId(row))

export function gitHubTaskReadInstructions(
  batch: ReadBatch,
  key: string,
  domains: ReadonlyMap<string, number>
): readonly ReadInstruction[] {
  const groups = batch.rows.get(key)
  if (!groups) {
    return []
  }
  // Only groups for this row participate; aliases retain the consumer's original domain order.
  return [...groups]
    .filter(([domain]) => domains.has(domain))
    .sort(([a], [b]) => domains.get(a)! - domains.get(b)!)
    .flatMap(([, instructions]) => instructions)
}
