/** Builds one merge's project groups; groups and rows shared with the cache are copied before they change. */

import type { ChatRowGroup, ResourceMergeCache } from './resource-chat-row-groups'
import type { UnifiedProjectGroup, UnifiedWorktreeRow } from './resource-usage-merge-types'

type RepoState = {
  group: UnifiedProjectGroup
  // True while `group` is a cached object this merge must not change.
  shared: boolean
  // Row positions of whole chat groups, at their offsets, in the order added.
  layers: { offset: number; rowIndexById: ReadonlyMap<string, number> }[]
  // Row positions of rows added one at a time.
  ownIndex: Map<string, number>
  parts: ChatRowGroup[]
  // Anything other than whole chat groups was added or changed.
  dirty: boolean
}

function addTotals(group: UnifiedProjectGroup, cpu: number | null, memory: number | null): void {
  // Only sampled rows count; a project with none keeps null totals.
  if (cpu !== null && memory !== null) {
    group.cpu = (group.cpu ?? 0) + cpu
    group.memory = (group.memory ?? 0) + memory
  }
}

export class ProjectGroupAssembly {
  private readonly repos = new Map<string, RepoState>()
  // Rows built in this merge; any other row is copied before it changes.
  private readonly ownRows = new Set<UnifiedWorktreeRow>()

  addChatRowGroup(part: ChatRowGroup): void {
    const { group, rowIndexById } = part
    const state = this.repos.get(group.repoId)
    if (!state) {
      this.repos.set(group.repoId, {
        group,
        shared: true,
        layers: [{ offset: 0, rowIndexById }],
        ownIndex: new Map(),
        parts: [part],
        dirty: false
      })
      return
    }
    const target = this.own(state)
    state.layers.push({ offset: target.worktrees.length, rowIndexById })
    state.parts.push(part)
    for (const row of group.worktrees) {
      target.worktrees.push(row)
    }
    target.hasRemoteChildren ||= group.hasRemoteChildren
    addTotals(target, group.cpu, group.memory)
  }

  /** Adds a row built in this merge, creating its project when needed. */
  appendNewRow(row: UnifiedWorktreeRow): UnifiedWorktreeRow {
    this.ownRows.add(row)
    let state = this.repos.get(row.repoId)
    if (!state) {
      state = {
        group: {
          repoId: row.repoId,
          repoName: row.repoName,
          cpu: null,
          memory: null,
          hasRemoteChildren: false,
          worktrees: []
        },
        shared: false,
        layers: [],
        ownIndex: new Map(),
        parts: [],
        dirty: true
      }
      this.repos.set(row.repoId, state)
    }
    const target = this.own(state)
    state.dirty = true
    if (!state.ownIndex.has(row.worktreeId)) {
      state.ownIndex.set(row.worktreeId, target.worktrees.length)
    }
    target.worktrees.push(row)
    target.hasRemoteChildren ||= row.isRemote
    addTotals(target, row.cpu, row.memory)
    return row
  }

  /** The workspace's row, safe to change in this merge; undefined when it has none yet. */
  rowToUpdate(repoId: string, worktreeId: string): UnifiedWorktreeRow | undefined {
    const state = this.repos.get(repoId)
    const position = state ? this.position(state, worktreeId) : undefined
    if (!state || position === undefined) {
      return undefined
    }
    const target = this.own(state)
    state.dirty = true
    const row = target.worktrees[position]
    if (this.ownRows.has(row)) {
      return row
    }
    // Terminals and browsers carry no samples, so the project's totals stay as they are.
    const copy = { ...row, sessions: [...row.sessions], browsers: [...row.browsers] }
    target.worktrees[position] = copy
    this.ownRows.add(copy)
    return copy
  }

  /** The merged groups; a project made only of the same unchanged chat groups keeps its last object. */
  finish(cache: ResourceMergeCache | undefined): UnifiedProjectGroup[] {
    const combined = new Map<string, { parts: ChatRowGroup[]; group: UnifiedProjectGroup }>()
    const groups: UnifiedProjectGroup[] = []
    for (const [repoId, state] of this.repos) {
      let group = state.group
      if (!state.dirty && state.parts.length > 1) {
        const prior = cache?.combinedByRepo.get(repoId)
        if (
          prior &&
          prior.parts.length === state.parts.length &&
          prior.parts.every((part, i) => part === state.parts[i])
        ) {
          group = prior.group
        }
        combined.set(repoId, { parts: state.parts, group })
      }
      groups.push(group)
    }
    if (cache) {
      cache.combinedByRepo = combined
    }
    return groups
  }

  private own(state: RepoState): UnifiedProjectGroup {
    if (state.shared) {
      state.group = { ...state.group, worktrees: [...state.group.worktrees] }
      state.shared = false
    }
    return state.group
  }

  private position(state: RepoState, worktreeId: string): number | undefined {
    for (const { offset, rowIndexById } of state.layers) {
      const index = rowIndexById.get(worktreeId)
      if (index !== undefined) {
        return offset + index
      }
    }
    return state.ownIndex.get(worktreeId)
  }
}
