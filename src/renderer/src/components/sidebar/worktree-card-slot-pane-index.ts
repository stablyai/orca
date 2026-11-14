import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'

/**
 * What the slot projection itself recorded about each pane: which workspaces display it, and when
 * its live status stops being fresh. Invalidation reads these instead of re-deriving ownership
 * with its own rules, so a pane-keyed change (status, acknowledgement, freshness) reaches exactly
 * the workspaces whose slots were built from it.
 */

const displayersByPane = new Map<string, Set<HostScopedWorktreeKey>>()
const panesByIdentity = new Map<HostScopedWorktreeKey, readonly string[]>()

/** Called with every projection of a workspace slot; replaces that workspace's previous panes. */
export function recordDisplayedPanes(
  identity: HostScopedWorktreeKey,
  panes: readonly string[]
): void {
  forgetDisplayedPanes(identity)
  if (panes.length === 0) {
    return
  }
  panesByIdentity.set(identity, panes)
  for (const pane of panes) {
    let displayers = displayersByPane.get(pane)
    if (!displayers) {
      displayers = new Set()
      displayersByPane.set(pane, displayers)
    }
    displayers.add(identity)
  }
}

function forgetDisplayedPanes(identity: HostScopedWorktreeKey): void {
  for (const pane of panesByIdentity.get(identity) ?? []) {
    const displayers = displayersByPane.get(pane)
    displayers?.delete(identity)
    if (displayers?.size === 0) {
      displayersByPane.delete(pane)
    }
  }
  panesByIdentity.delete(identity)
}

/** Retire removed owners without evicting associations still used by cached lineage trees. */
export function forgetDisplayedPanesForWorktrees(
  targets: readonly { id: string; hostId?: ExecutionHostId }[]
): void {
  const hostsById = new Map<string, Set<ExecutionHostId | undefined>>()
  for (const { id, hostId } of targets) {
    let hosts = hostsById.get(id)
    if (!hosts) {
      hosts = new Set()
      hostsById.set(id, hosts)
    }
    hosts.add(hostId)
  }
  for (const identity of panesByIdentity.keys()) {
    const hosts = hostsById.get(getWorktreeIdFromHostIdentity(identity))
    if (
      hosts &&
      (hosts.has(undefined) || hosts.has(getExecutionHostIdFromWorktreeHostIdentity(identity)))
    ) {
      forgetDisplayedPanes(identity)
    }
  }
}

/** Bare ids of the workspaces whose last projection displayed the pane. */
export function forEachPaneDisplayer(paneKey: string, visit: (worktreeId: string) => void): void {
  for (const identity of displayersByPane.get(paneKey) ?? []) {
    visit(getWorktreeIdFromHostIdentity(identity))
  }
}

/**
 * The moment a live entry stops being fresh, or null when time alone never changes it
 * (unconfirmed restores are never fresh; host-owned structured sessions always are).
 * Mirrors `isAgentStatusFresh`: fresh while `now - evidence <= staleAfter`.
 */
export function agentStatusStaleAt(entry: AgentStatusEntry): number | null {
  if (entry.restoredUnconfirmed === true || entry.structuredHostOwned === true) {
    return null
  }
  return agentStatusEvidenceObservedAt(entry) + AGENT_STATUS_STALE_AFTER_MS
}

type Deadline = { at: number; paneKey: string; entry: AgentStatusEntry }

/**
 * Live entries ordered by when they go stale, so a clock advance visits only the entries whose
 * freshness flipped: O(k log n), not a scan of every live entry. Keyed by pane; superseded heap
 * items are skipped on pop and compacted away when they outnumber the live ones.
 */
export function createFreshnessDeadlines() {
  const heap: Deadline[] = []
  const current = new Map<string, Deadline>()

  const less = (a: Deadline, b: Deadline): boolean => a.at < b.at
  function siftUp(index: number): void {
    const item = heap[index]!
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (!less(item, heap[parent]!)) {
        break
      }
      heap[index] = heap[parent]!
      index = parent
    }
    heap[index] = item
  }
  function siftDown(index: number): void {
    const item = heap[index]!
    for (;;) {
      const left = 2 * index + 1
      if (left >= heap.length) {
        break
      }
      const right = left + 1
      const child = right < heap.length && less(heap[right]!, heap[left]!) ? right : left
      if (!less(heap[child]!, item)) {
        break
      }
      heap[index] = heap[child]!
      index = child
    }
    heap[index] = item
  }
  function pop(): Deadline | undefined {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length > 0 && last) {
      heap[0] = last
      siftDown(0)
    }
    return top
  }
  function compact(): void {
    heap.length = 0
    for (const deadline of current.values()) {
      heap.push(deadline)
    }
    for (let index = (heap.length >> 1) - 1; index >= 0; index -= 1) {
      siftDown(index)
    }
  }

  return {
    /** Track the pane's entry as of clock `now`; an entry already stale, or absent, is dropped. */
    set(paneKey: string, entry: AgentStatusEntry | undefined, now: number): void {
      const at = entry ? agentStatusStaleAt(entry) : null
      if (!entry || at === null || at < now) {
        current.delete(paneKey)
        return
      }
      const deadline = { at, paneKey, entry }
      current.set(paneKey, deadline)
      heap.push(deadline)
      siftUp(heap.length - 1)
      if (heap.length > 64 && heap.length > 2 * current.size) {
        compact()
      }
    },
    /** Visit each tracked pane fresh at `before` and stale at `after`, and stop tracking it. */
    expire(after: number, visit: (paneKey: string, entry: AgentStatusEntry) => void): void {
      while (heap.length > 0 && heap[0]!.at < after) {
        const deadline = pop()!
        if (current.get(deadline.paneKey) !== deadline) {
          continue
        }
        current.delete(deadline.paneKey)
        visit(deadline.paneKey, deadline.entry)
      }
    },
    clear(): void {
      heap.length = 0
      current.clear()
    }
  }
}
