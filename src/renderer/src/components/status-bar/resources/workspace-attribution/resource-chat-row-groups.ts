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
  /** The sample's workspaces with terminals, whose rows are rebuilt every merge. */
  terminalSamples: readonly WorktreeMemory[]
}

/** Lives while the panel is open; samples are keyed by owner (this machine or a paired host). */
export type ResourceMergeCache = {
  bySample: Map<string, SampleChatRows>
  combinedByRepo: Map<string, { parts: ChatRowGroup[]; group: UnifiedProjectGroup }>
}

export function createResourceMergeCache(): ResourceMergeCache {
  return { bySample: new Map(), combinedByRepo: new Map() }
}

export function isChatOnlySample(wt: WorktreeMemory): boolean {
  return wt.sessions.length === 0
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

function buildChatRowGroups(
  source: readonly WorktreeMemory[],
  place: (wt: WorktreeMemory) => SamplePlacement | null
): ChatRowGroup[] {
  const byRepo = new Map<
    string,
    { group: UnifiedProjectGroup; rowIndexById: Map<string, number> }
  >()
  for (const wt of source) {
    if (!isChatOnlySample(wt)) {
      continue
    }
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

/** The sample's chat-only groups and terminal samples, rebuilt only when the sample or the catalog it is placed by changes. */
export function sampleRowsFor(
  cache: ResourceMergeCache | undefined,
  next: Map<string, SampleChatRows>,
  owner: string,
  source: readonly WorktreeMemory[],
  inputs: readonly unknown[],
  place: (wt: WorktreeMemory) => SamplePlacement | null
): SampleChatRows {
  const prior = cache?.bySample.get(owner)
  const entry =
    prior && prior.source === source && sameInputs(prior.inputs, inputs)
      ? prior
      : {
          source,
          inputs,
          groups: buildChatRowGroups(source, place),
          terminalSamples: source.filter((wt) => !isChatOnlySample(wt))
        }
  next.set(owner, entry)
  return entry
}
