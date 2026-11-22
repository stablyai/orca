/** Each sample's chat-only rows, grouped by project once per sample, so other updates reuse them untouched. */

import type { WorktreeMemory } from '../../../../../../shared/diagnostics/process-stats-types'
import type { SamplePlacement } from './resource-sample-placement'
import type { UnifiedProjectGroup, UnifiedWorktreeRow } from './resource-usage-merge-types'

/** A read-only project group of one sample's chat-only rows. */
export type ChatRowGroup = {
  group: UnifiedProjectGroup
  rowIndexById: ReadonlyMap<string, number>
}

export type SampleChatRows = {
  source: readonly WorktreeMemory[]
  inputs: readonly unknown[]
  groups: ChatRowGroup[]
  /** Set only when the sample has chat-only rows: its terminal rows, so a repeat merge skips the chats. */
  terminalSamples?: readonly WorktreeMemory[]
}

/** Lives while the panel is open; samples are keyed by owner (this machine or a paired host). */
export type ResourceMergeCache = { bySample: Map<string, SampleChatRows> }

export function createResourceMergeCache(): ResourceMergeCache {
  return { bySample: new Map() }
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

export function buildChatRowGroups(
  chatOnly: readonly WorktreeMemory[],
  place: (wt: WorktreeMemory) => SamplePlacement | null
): ChatRowGroup[] {
  const byRepo = new Map<
    string,
    { group: UnifiedProjectGroup; rowIndexById: Map<string, number> }
  >()
  for (const wt of chatOnly) {
    const placement = place(wt)
    if (!placement) {
      continue
    }
    const { readOnly: _readOnly, ...rowPlacement } = placement
    const row: UnifiedWorktreeRow = {
      ...rowPlacement,
      cpu: wt.cpu,
      memory: wt.memory,
      history: wt.history,
      hasLocalSamples: true,
      sessions: [],
      chats: wt.chats,
      browsers: []
    }
    let entry = byRepo.get(row.repoId)
    if (!entry) {
      entry = {
        group: {
          repoId: row.repoId,
          repoName: row.repoName,
          cpu: 0,
          memory: 0,
          hasRemoteChildren: false,
          worktrees: []
        },
        rowIndexById: new Map()
      }
      byRepo.set(row.repoId, entry)
    }
    const { group, rowIndexById } = entry
    if (!rowIndexById.has(row.worktreeId)) {
      rowIndexById.set(row.worktreeId, group.worktrees.length)
    }
    group.worktrees.push(row)
    group.hasRemoteChildren ||= row.isRemote
    group.cpu = (group.cpu ?? 0) + wt.cpu
    group.memory = (group.memory ?? 0) + wt.memory
  }
  return [...byRepo.values()]
}

/** The sample's cached rows, while the sample and the catalog it is placed by are unchanged. */
export function chatRowGroupsFor(
  cache: ResourceMergeCache | undefined,
  owner: string,
  source: readonly WorktreeMemory[],
  inputs: readonly unknown[]
): SampleChatRows | undefined {
  const prior = cache?.bySample.get(owner)
  return prior && prior.source === source && sameInputs(prior.inputs, inputs) ? prior : undefined
}
