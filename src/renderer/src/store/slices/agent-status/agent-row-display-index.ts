import type { AgentGroupSummary, AgentChildren, Group, Placement } from './agent-row-display-model'
import { EMPTY_KEYS, EMPTY_CHILDREN, sameKeys, sameChildren } from './agent-row-display-model'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { buildAgentRowLineageTree } from '@/components/dashboard/agent-row-lineage-model'
import { agentRowDisplayDotState } from '@/lib/agent-status/presentation/agent-row-dot-state'
import { SUMMARY_STATE_ORDER } from '@/components/sidebar/workspace-card/activity/worktree-card-agent-summary'
import type { AgentDotState } from '@/components/AgentStateDot'
import { KeyedDeadlines } from '../../../../../shared/keyed-deadlines'

/** Display membership changes separately from immutable per-key row presentations. */
export class AgentRowDisplayIndex {
  private readonly ownerKeys = new Map<string, readonly string[]>()
  private readonly placements = new Map<string, Placement>()
  private readonly rootKeys = new Map<string, readonly string[]>()
  private readonly childrenKeys = new Map<string, readonly string[]>()
  private readonly descendants = new Map<string, Map<AgentDotState, number>>()
  private readonly childrenOutput = new Map<string, AgentChildren>()
  private readonly groups = new Map<string, Map<AgentDotState, Group>>()
  private readonly summaries = new Map<string, readonly AgentGroupSummary[]>()

  roots(owner: string): readonly string[] {
    return this.rootKeys.get(owner) ?? EMPTY_KEYS
  }
  summary(owner: string): readonly AgentGroupSummary[] {
    let summary = this.summaries.get(owner)
    if (summary) {
      return summary
    }
    const groups = this.groups.get(owner)
    summary = SUMMARY_STATE_ORDER.flatMap((state) => {
      const group = groups?.get(state)
      if (!group?.size) {
        return []
      }
      const identities = [...group].sort((a, b) => b[1].size - a[1].size || a[1].next - b[1].next)
      return [
        {
          state,
          identities: identities.map(([, heap]) => ({
            agentType: this.placements.get(heap.firstKey!)!.agentType,
            count: heap.size
          })),
          count: identities.reduce((sum, [, heap]) => sum + heap.size, 0),
          icons: identities.slice(0, 3).map(([, heap]) => {
            const paneKey = heap.firstKey!,
              placement = this.placements.get(paneKey)!
            return { paneKey, agentType: placement.agentType }
          })
        }
      ]
    })
    this.summaries.set(owner, summary)
    return summary
  }
  children(key: string): AgentChildren {
    const keys = this.childrenKeys.get(key)
    if (!keys?.length) {
      return EMPTY_CHILDREN
    }
    let output = this.childrenOutput.get(key)
    if (output) {
      return output
    }
    const idle = keys.filter((key) => this.placements.get(key)?.state === 'idle')
    const signal = SUMMARY_STATE_ORDER.find(
      (state) =>
        !['idle', 'done', 'unverifiable'].includes(state) &&
        (this.descendants.get(key)?.get(state) ?? 0) > 0
    )
    output = {
      keys,
      active:
        idle.length < 2 ? keys : keys.filter((key) => this.placements.get(key)?.state !== 'idle'),
      idle: idle.length < 2 ? EMPTY_KEYS : idle,
      signal
    }
    this.childrenOutput.set(key, output)
    return output
  }
  update(key: string, row: DashboardAgentRow | undefined): string[] {
    const previous = this.placements.get(key)
    if (!previous || !row) {
      return []
    }
    const state = agentRowDisplayDotState(row),
      agentType = row.agentType
    if (state === previous.state && agentType === previous.agentType) {
      return []
    }
    if (!previous.parent) {
      this.adjustGroup(key, previous, -1)
    }
    const next = { ...previous, state, agentType }
    this.placements.set(key, next)
    if (!previous.parent) {
      this.adjustGroup(key, next, 1)
    }
    const parents: string[] = [],
      visited = new Set<string>()
    for (
      let parent = previous.parent;
      parent && !visited.has(parent);
      parent = this.placements.get(parent)?.parent
    ) {
      visited.add(parent)
      parents.push(parent)
      const counts = this.descendants.get(parent)!
      this.adjustCount(counts, previous.state, -1)
      this.adjustCount(counts, state, 1)
      this.childrenOutput.delete(parent)
    }
    return parents
  }
  arrange(owner: string, rows: readonly DashboardAgentRow[]): readonly string[] {
    const previousKeys = this.ownerKeys.get(owner) ?? EMPTY_KEYS
    const previousChildren = new Map(previousKeys.map((key) => [key, this.children(key)]))
    const previousRoots = this.roots(owner)
    const tree = buildAgentRowLineageTree(rows)
    for (const key of this.ownerKeys.get(owner) ?? []) {
      this.placements.delete(key)
      this.childrenKeys.delete(key)
      this.descendants.delete(key)
      this.childrenOutput.delete(key)
    }
    if (rows.length) {
      this.ownerKeys.set(
        owner,
        rows.map((row) => row.paneKey)
      )
    } else {
      this.ownerKeys.delete(owner)
    }
    const parents = new Map<string, string>()
    for (const [key, children] of tree.childrenByParentPaneKey) {
      this.childrenKeys.set(
        key,
        children.map((row) => row.paneKey)
      )
      for (const child of children) {
        parents.set(child.paneKey, key)
      }
    }
    this.rootKeys.set(
      owner,
      tree.rootRows.map((row) => row.paneKey)
    )
    this.groups.delete(owner)
    this.summaries.delete(owner)
    rows.forEach((row, rank) =>
      this.placements.set(row.paneKey, {
        owner,
        rank,
        parent: parents.get(row.paneKey),
        state: agentRowDisplayDotState(row),
        agentType: row.agentType
      })
    )
    const countsFor = (key: string, visiting: Set<string>): Map<AgentDotState, number> => {
      const cached = this.descendants.get(key)
      if (cached) {
        return cached
      }
      const counts = new Map<AgentDotState, number>()
      this.descendants.set(key, counts)
      if (visiting.has(key)) {
        return counts
      }
      visiting.add(key)
      for (const child of this.childrenKeys.get(key) ?? []) {
        this.adjustCount(counts, this.placements.get(child)!.state, 1)
        for (const [state, count] of countsFor(child, visiting)) {
          this.adjustCount(counts, state, count)
        }
      }
      visiting.delete(key)
      return counts
    }
    for (const row of rows) {
      countsFor(row.paneKey, new Set())
    }
    for (const key of this.roots(owner)) {
      this.adjustGroup(key, this.placements.get(key)!, 1)
    }
    if (!rows.length) {
      this.rootKeys.delete(owner)
    } else if (sameKeys(previousRoots, this.roots(owner))) {
      this.rootKeys.set(owner, previousRoots)
    }
    const changed: string[] = []
    for (const key of new Set([...previousKeys, ...rows.map((row) => row.paneKey)])) {
      const before = previousChildren.get(key) ?? EMPTY_CHILDREN
      const after = this.children(key)
      if (sameChildren(before, after)) {
        if (after.keys.length) {
          this.childrenKeys.set(key, before.keys)
          this.childrenOutput.set(key, before)
        }
      } else {
        changed.push(key)
      }
    }
    return changed
  }
  capture(): AgentRowDisplayIndex {
    const captured = new AgentRowDisplayIndex()
    for (const [key, value] of this.ownerKeys) {
      captured.ownerKeys.set(key, value)
    }
    for (const [key, value] of this.placements) {
      captured.placements.set(key, value)
    }
    for (const [key, value] of this.rootKeys) {
      captured.rootKeys.set(key, value)
    }
    for (const [key, value] of this.childrenKeys) {
      captured.childrenKeys.set(key, value)
    }
    for (const [key, value] of this.childrenOutput) {
      captured.childrenOutput.set(key, value)
    }
    for (const [key, value] of this.descendants) {
      captured.descendants.set(key, new Map(value))
    }
    for (const [key, value] of this.summaries) {
      captured.summaries.set(key, value)
    }
    for (const [owner, states] of this.groups) {
      captured.groups.set(
        owner,
        new Map(
          [...states].map(([state, identities]) => [
            state,
            new Map([...identities].map(([type, heap]) => [type, heap.capture()]))
          ])
        )
      )
    }
    return captured
  }
  private adjustGroup(key: string, placement: Placement, delta: 1 | -1): void {
    let states = this.groups.get(placement.owner)
    if (!states) {
      this.groups.set(placement.owner, (states = new Map()))
    }
    let group = states.get(placement.state)
    if (!group) {
      states.set(placement.state, (group = new Map()))
    }
    const type = placement.agentType ?? 'unknown'
    let heap = group.get(type)
    if (!heap) {
      group.set(type, (heap = new KeyedDeadlines()))
    }
    if (delta === 1) {
      heap.set(key, placement.rank)
    } else {
      heap.delete(key)
    }
    if (!heap.size) {
      group.delete(type)
    }
    if (!group.size) {
      states.delete(placement.state)
    }
    if (!states.size) {
      this.groups.delete(placement.owner)
    }
    this.summaries.delete(placement.owner)
  }
  private adjustCount(
    counts: Map<AgentDotState, number>,
    state: AgentDotState,
    delta: number
  ): void {
    const count = (counts.get(state) ?? 0) + delta
    if (count) {
      counts.set(state, count)
    } else {
      counts.delete(state)
    }
  }
}

export type { AgentGroupSummary, AgentChildren } from './agent-row-display-model'
