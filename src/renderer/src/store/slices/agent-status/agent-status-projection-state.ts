import { AgentRowDisplayIndex } from './agent-row-display-index'
import type { AppState } from '../../types'
import type {
  AgentType,
  AgentStatusEntry
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Tab } from '../../../../../shared/tab-types'
import { KeyedDeadlines } from '../../../../../shared/keyed-deadlines'
import type { TabAgentPane } from '@/lib/agent-session/tab-identity/tab-agent-status-index'
import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../../shared/structural-value-equality'
import {
  FLAGS,
  type Contribution,
  type DashboardCounts,
  EMPTY_COUNTS,
  type CountedRow,
  type Candidate,
  type Bucket,
  bucket
} from './agent-status-projection-types'

export class AgentStatusProjectionState {
  display = new AgentRowDisplayIndex()
  activeDashboardOwners = new Set<string>()
  readonly countedRows = new Map<string, CountedRow>()
  readonly countsByWorktree = new Map<string, DashboardCounts>()
  dashboardTotals: DashboardCounts = EMPTY_COUNTS
  readonly listeners = new Map<string, Set<() => void>>()
  readonly changedKeys = new Set<string>()
  fullResync = false
  readonly changeListeners = new Set<(keys: ReadonlySet<string> | null) => void>()
  readonly notices = new Set<string>()
  notifying = false
  inputs: AppState | null = null
  readonly tabs = new Map<string, TerminalTab>()
  readonly tabWorktrees = new Map<string, string>()
  represented: ReadonlyMap<string, Tab> = new Map()
  readonly orphanOwners = new Map<string, string>()
  readonly orphansByOwner = new Map<string, Set<string>>()
  readonly handleByKey = new Map<string, string>()
  readonly keysByHandle = new Map<string, Set<string>>()
  readonly acceptedByTab = new Map<string, Set<string>>()
  readonly worktrees = new Map<string, Bucket>()
  readonly mobileKeys = new Map<string, Set<string>>()
  readonly mobileOwners = new Map<string, string>()
  readonly mobileOutputs = new Map<string, ReadonlyMap<string, AgentStatusEntry>>()
  readonly rows = new Map<string, DashboardAgentRow>()
  readonly rowsForSource = new Map<string, readonly string[]>()
  readonly ownerForSource = new Map<string, string>()
  readonly fallbackRows = new Map<string, DashboardAgentRow>()
  readonly fallbackByTab = new Map<string, Set<string>>()
  readonly unsupportedRows = new Map<string, AgentStatusEntry>()
  readonly contributions = new Map<string, Contribution>()
  readonly suppressed = new Map<string, number>()
  readonly suppressionsBySource = new Map<string, readonly string[]>()
  readonly ranks = new Map<string, number>()
  readonly tabTypes: Record<string, AgentType> = {}
  readonly unsafeTabs: Record<string, true> = {}
  tabProjection = {
    tabAgentTypesByTabId: this.tabTypes,
    nativeChatTabWideFallbackUnsafeTabsById: this.unsafeTabs,
    revision: 0
  }
  nextRank = 0
  freshEvidence = 0
  readonly candidates = new Map<string, Candidate>()
  deadCandidates = new KeyedDeadlines()
  freshCandidates = new KeyedDeadlines()
  candidateExpiries = new KeyedDeadlines()
  readonly icons = new Map<string, { tabId: string; done: boolean; pane: TabAgentPane }>()
  readonly iconsByTab = new Map<
    string,
    {
      live: Set<string>
      done: Set<string>
      liveOutput?: readonly TabAgentPane[]
      doneOutput?: readonly TabAgentPane[]
    }
  >()
  readonly fullRows = new Map<string, { revision: number; rows: DashboardAgentRow[] }>()
  getBucket(owner: string): Bucket {
    let b = this.worktrees.get(owner)
    if (!b) {
      this.worktrees.set(owner, (b = bucket()))
    }
    return b
  }
  replaceIcon(key: string, icon: { tabId: string; done: boolean }, add: boolean): void {
    let bucket = this.iconsByTab.get(icon.tabId)
    if (!bucket) {
      this.iconsByTab.set(icon.tabId, (bucket = { live: new Set(), done: new Set() }))
    }
    const field = icon.done ? 'done' : 'live'
    if (add) {
      bucket[field].add(key)
    } else {
      bucket[field].delete(key)
    }
    bucket[icon.done ? 'doneOutput' : 'liveOutput'] = undefined
    if (!bucket.live.size && !bucket.done.size) {
      this.iconsByTab.delete(icon.tabId)
    }
  }
  replaceContribution(key: string, next: Contribution | undefined): void {
    const previous = this.contributions.get(key)
    if (equal(previous, next)) {
      return
    }
    if (previous?.fresh) {
      this.freshEvidence--
    }
    if (next?.fresh) {
      this.freshEvidence++
    }
    const deltas = new Map<string, Map<string, number>>()
    const contribute = (c: Contribution, sign: 1 | -1) => {
      let counts = deltas.get(c.worktreeId)
      if (!counts) {
        deltas.set(c.worktreeId, (counts = new Map()))
      }
      const counters = [
        ...c.flags,
        ...c.panes.map((id) => `pane\0${id}`),
        ...c.stale.map((id) => `stale\0${id}`)
      ]
      if (c.titleState === 'blocked' || c.titleState === 'waiting') {
        counters.push('titlePermission')
      }
      if (c.titleState === 'working') {
        counters.push('titleWorking')
      }
      for (const counter of counters) {
        counts.set(counter, (counts.get(counter) ?? 0) + sign)
      }
    }
    if (previous) {
      contribute(previous, -1)
    }
    if (next) {
      contribute(next, 1)
    }
    for (const [owner, deltasForOwner] of deltas) {
      const b = this.getBucket(owner)
      let changed = false
      for (const [counter, delta] of deltasForOwner) {
        if (!delta) {
          continue
        }
        const before = b.counts.get(counter) ?? 0,
          after = this.adjustCounter(b, counter, delta)
        if (Boolean(before) === Boolean(after)) {
          continue
        }
        if (counter.startsWith('pane\0') || counter.startsWith('stale\0')) {
          const [prefix, tab, pane] = counter.split('\0'),
            field = prefix === 'pane' ? 'agentStatusPaneIdsByTabId' : 'stalePaneIdsByTabId'
          const byTab = b.summary[field],
            panes = byTab[tab]
          if (after) {
            const set = new Set(panes)
            set.add(pane)
            byTab[tab] = set
          } else {
            const set = new Set(panes)
            set.delete(pane)
            if (set.size) {
              byTab[tab] = set
            } else {
              delete byTab[tab]
            }
          }
          changed = true
        } else if (FLAGS.some((flag) => flag === counter)) {
          changed = true
        }
      }
      if (changed) {
        const summary = { ...b.summary, revision: (b.summary.revision ?? 0) + 1 }
        for (const flag of FLAGS) {
          summary[flag] = (b.counts.get(flag) ?? 0) > 0
        }
        b.summary = summary
      }
    }
    if (previous) {
      for (const heap of this.getBucket(previous.worktreeId).attention) {
        heap.delete(key)
      }
    }
    if (next && next.attention.cls < 5) {
      this.getBucket(next.worktreeId).attention[next.attention.cls - 1].set(
        key,
        -next.attention.attentionTimestamp
      )
    }
    if (next) {
      this.contributions.set(key, next)
    } else {
      this.contributions.delete(key)
    }
  }
  adjustCounter(b: Bucket, key: string, delta: number): number {
    const count = (b.counts.get(key) ?? 0) + delta
    if (count) {
      b.counts.set(key, count)
    } else {
      b.counts.delete(key)
    }
    return count
  }
}
