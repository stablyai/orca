/** Each sample's chat-only rows, grouped by project once per sample, so other updates reuse them untouched. */

import type {
  ChatAgentMemory,
  WorktreeMemory
} from '../../../../../../shared/diagnostics/process-stats-types'
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
  /** Chat lists of workspaces that also have terminals, kept while they render the same. */
  mixedChats?: ReadonlyMap<string, readonly ChatAgentMemory[]>
}

/** Lives while the panel is open; samples are keyed by owner (this machine or a paired host). */
export type ResourceMergeCache = { bySample: Map<string, SampleChatRows> }

export function createResourceMergeCache(): ResourceMergeCache {
  return { bySample: new Map() }
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) {
    return true
  }
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/** Whether two chat lists render the same. */
export function sameChats(
  before: readonly ChatAgentMemory[],
  after: readonly ChatAgentMemory[]
): boolean {
  return (
    before === after ||
    (before.length === after.length &&
      before.every((chat, i) => {
        const next = after[i]
        return (
          chat.agentSessionId === next.agentSessionId &&
          chat.agent === next.agent &&
          chat.name === next.name &&
          chat.cpu === next.cpu &&
          chat.memory === next.memory
        )
      }))
  )
}

/** The fresh chat list, reusing each earlier entry that renders the same, and the earlier list when all do. */
export function reuseChats(
  before: readonly ChatAgentMemory[] | undefined,
  after: readonly ChatAgentMemory[]
): readonly ChatAgentMemory[] {
  if (!before) {
    return after
  }
  if (sameChats(before, after)) {
    return before
  }
  const earlier = new Map(before.map((chat) => [chat.agentSessionId, chat]))
  return after.map((chat) => {
    const prior = earlier.get(chat.agentSessionId)
    return prior && sameChats([prior], [chat]) ? prior : chat
  })
}

/** Whether a fresh sample of a workspace renders exactly as its earlier row did. */
function rendersSame(
  row: UnifiedWorktreeRow,
  placement: Omit<SamplePlacement, 'readOnly'>,
  wt: WorktreeMemory
): boolean {
  return (
    // Placement can fall back to the sample's own names, so a renamed workspace must not keep its old row.
    row.worktreeName === placement.worktreeName &&
    row.repoId === placement.repoId &&
    row.repoName === placement.repoName &&
    row.isRemote === placement.isRemote &&
    row.hostLabel === placement.hostLabel &&
    row.unplaced === placement.unplaced &&
    row.cpu === wt.cpu &&
    row.memory === wt.memory &&
    sameChats(row.chats ?? [], wt.chats ?? []) &&
    sameNumbers(row.history, wt.history)
  )
}

/**
 * Groups a sample's chat-only rows by project. With the earlier sample's groups (placed by the same
 * catalog), a row that renders the same keeps its object, and a group of kept rows keeps its own, so
 * a fresh but unchanged sample redraws nothing.
 */
export function buildChatRowGroups(
  chatOnly: readonly WorktreeMemory[],
  place: (wt: WorktreeMemory) => SamplePlacement | null,
  prior?: readonly ChatRowGroup[]
): ChatRowGroup[] {
  const priorRows = new Map<string, UnifiedWorktreeRow>()
  const priorGroups = new Map<string, ChatRowGroup>()
  for (const part of prior ?? []) {
    priorGroups.set(part.group.repoId, part)
    for (const row of part.group.worktrees) {
      priorRows.set(row.worktreeId, row)
    }
  }
  const byRepo = new Map<
    string,
    { group: UnifiedProjectGroup; rowIndexById: Map<string, number>; kept: boolean }
  >()
  for (const wt of chatOnly) {
    const placement = place(wt)
    if (!placement) {
      continue
    }
    const { readOnly: _readOnly, ...rowPlacement } = placement
    const earlier = priorRows.get(rowPlacement.worktreeId)
    const reused = earlier !== undefined && rendersSame(earlier, rowPlacement, wt)
    const row: UnifiedWorktreeRow = reused
      ? earlier
      : {
          ...rowPlacement,
          cpu: wt.cpu,
          memory: wt.memory,
          history: wt.history,
          hasLocalSamples: true,
          sessions: [],
          chats: wt.chats && reuseChats(earlier?.chats, wt.chats),
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
        rowIndexById: new Map(),
        kept: true
      }
      byRepo.set(row.repoId, entry)
    }
    const { group, rowIndexById } = entry
    if (!rowIndexById.has(row.worktreeId)) {
      rowIndexById.set(row.worktreeId, group.worktrees.length)
    }
    entry.kept &&=
      reused && priorGroups.get(row.repoId)?.group.worktrees[group.worktrees.length] === row
    group.worktrees.push(row)
    group.hasRemoteChildren ||= row.isRemote
    group.cpu = (group.cpu ?? 0) + wt.cpu
    group.memory = (group.memory ?? 0) + wt.memory
  }
  return [...byRepo.values()].map(({ group, rowIndexById, kept }) => {
    const earlier = priorGroups.get(group.repoId)
    return kept && earlier && earlier.group.worktrees.length === group.worktrees.length
      ? earlier
      : { group, rowIndexById }
  })
}

/** The owner's earlier groups, while the catalog they were placed by is unchanged. */
export function priorChatRowGroups(
  cache: ResourceMergeCache | undefined,
  owner: string,
  inputs: readonly unknown[]
): readonly ChatRowGroup[] | undefined {
  const prior = cache?.bySample.get(owner)
  return prior && sameInputs(prior.inputs, inputs) ? prior.groups : undefined
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
