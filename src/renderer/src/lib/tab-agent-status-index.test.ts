import { describe, expect, it } from 'vitest'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedRetainedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingRetainedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import { agentTypeToIconAgent } from './agent-status'
import { isTerminalLeafId, parsePaneKey } from '../../../shared/stable-pane-id'
import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab, TuiAgent } from '../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'

// ─── Oracle: the pre-index full-map scans, kept here (not in src) so the
// randomized suite can assert the indexed resolvers are byte-identical. ───

function oracleAnyTabAgent(
  map: Record<string, AgentStatusEntry>,
  tabId: string,
  excludedLeafId?: string
): TuiAgent | null {
  for (const [paneKey, entry] of Object.entries(map)) {
    const parsed = parsePaneKey(paneKey)
    if (parsed?.tabId === tabId && parsed.leafId !== excludedLeafId) {
      const agent = entry.state === 'done' ? null : agentTypeToIconAgent(entry.agentType)
      if (agent) {
        return agent
      }
    }
  }
  return null
}

function oracleAnyCompletedTabAgent(
  map: Record<string, AgentStatusEntry>,
  tabId: string,
  excludedLeafId?: string
): TuiAgent | null {
  for (const [paneKey, entry] of Object.entries(map)) {
    const parsed = parsePaneKey(paneKey)
    if (parsed?.tabId === tabId && parsed.leafId !== excludedLeafId) {
      const agent = entry.state === 'done' ? agentTypeToIconAgent(entry.agentType) : null
      if (agent) {
        return agent
      }
    }
  }
  return null
}

function oracleAnyRetainedTabAgent(
  map: Record<string, RetainedAgentEntry>,
  tabId: string,
  excludedLeafId?: string
): TuiAgent | null {
  for (const [paneKey, retained] of Object.entries(map)) {
    const parsed = parsePaneKey(paneKey)
    if (parsed?.tabId === tabId && parsed.leafId !== excludedLeafId) {
      const agent = agentTypeToIconAgent(retained.agentType)
      if (agent) {
        return agent
      }
    }
  }
  return null
}

function activeLeafOf(layout: TerminalLayoutSnapshot | undefined): string | null {
  const activeLeafId = layout?.activeLeafId
  return activeLeafId && isTerminalLeafId(activeLeafId) ? activeLeafId : null
}

const ORACLES = {
  focused: (
    map: Record<string, AgentStatusEntry>,
    layout: TerminalLayoutSnapshot | undefined,
    tabId: string
  ): TuiAgent | null => {
    const activeLeafId = activeLeafOf(layout)
    if (activeLeafId) {
      const entry = map[`${tabId}:${activeLeafId}`]
      return !entry || entry.state === 'done' ? null : agentTypeToIconAgent(entry.agentType)
    }
    return oracleAnyTabAgent(map, tabId)
  },
  sibling: (
    map: Record<string, AgentStatusEntry>,
    layout: TerminalLayoutSnapshot | undefined,
    tabId: string
  ): TuiAgent | null => {
    const activeLeafId = activeLeafOf(layout)
    return activeLeafId ? oracleAnyTabAgent(map, tabId, activeLeafId) : null
  },
  focusedCompleted: (
    map: Record<string, AgentStatusEntry>,
    layout: TerminalLayoutSnapshot | undefined,
    tabId: string
  ): TuiAgent | null => {
    const activeLeafId = activeLeafOf(layout)
    if (activeLeafId) {
      const entry = map[`${tabId}:${activeLeafId}`]
      return !entry || entry.state !== 'done' ? null : agentTypeToIconAgent(entry.agentType)
    }
    return oracleAnyCompletedTabAgent(map, tabId)
  },
  siblingCompleted: (
    map: Record<string, AgentStatusEntry>,
    layout: TerminalLayoutSnapshot | undefined,
    tabId: string
  ): TuiAgent | null => {
    const activeLeafId = activeLeafOf(layout)
    return activeLeafId ? oracleAnyCompletedTabAgent(map, tabId, activeLeafId) : null
  },
  focusedRetained: (
    map: Record<string, RetainedAgentEntry>,
    layout: TerminalLayoutSnapshot | undefined,
    tabId: string
  ): TuiAgent | null => {
    const activeLeafId = activeLeafOf(layout)
    if (activeLeafId) {
      return agentTypeToIconAgent(map[`${tabId}:${activeLeafId}`]?.agentType)
    }
    return oracleAnyRetainedTabAgent(map, tabId)
  },
  siblingRetained: (
    map: Record<string, RetainedAgentEntry>,
    layout: TerminalLayoutSnapshot | undefined,
    tabId: string
  ): TuiAgent | null => {
    const activeLeafId = activeLeafOf(layout)
    return activeLeafId ? oracleAnyRetainedTabAgent(map, tabId, activeLeafId) : null
  }
}

// ─── Fixtures ───

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function leafId(n: number): string {
  const hex = n.toString(16).padStart(12, '0')
  return `11111111-1111-4111-8111-${hex}`
}

const STATES: readonly AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']
// Mixes iconable agents with ones agentTypeToIconAgent rejects.
const AGENT_TYPES: readonly (AgentType | undefined)[] = [
  'claude',
  'codex',
  'gemini',
  'pi',
  'omp',
  'unknown',
  'some-custom-agent',
  undefined
]

function statusEntry(
  paneKey: string,
  state: AgentStatusState,
  agentType?: AgentType
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    paneKey,
    stateHistory: [],
    ...(agentType ? { agentType } : {})
  }
}

function retainedEntry(paneKey: string, agentType: AgentType): RetainedAgentEntry {
  const tabId = paneKey.slice(0, paneKey.indexOf(':'))
  const tab: TerminalTab = {
    id: tabId,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return {
    entry: { ...statusEntry(paneKey, 'done', agentType), state: 'done' },
    worktreeId: tab.worktreeId,
    tab,
    agentType,
    startedAt: 0
  }
}

function layoutOf(activeLeafId: string | null): TerminalLayoutSnapshot {
  return { root: null, activeLeafId, expandedLeafId: null }
}

function countEntryScans<T extends object>(source: T): { source: T; scans: () => number } {
  let scanCount = 0
  return {
    source: new Proxy(source, {
      ownKeys: (target) => {
        scanCount += 1
        return Reflect.ownKeys(target)
      }
    }),
    scans: () => scanCount
  }
}

type RandomCase = {
  statusMap: Record<string, AgentStatusEntry>
  retainedMap: Record<string, RetainedAgentEntry>
  probes: { tabId: string; layout: TerminalLayoutSnapshot | undefined }[]
}

function generateCase(random: () => number): RandomCase {
  const tabCount = 1 + Math.floor(random() * 6)
  const tabIds = Array.from({ length: tabCount }, (_, i) => `tab-${i}`)
  const paneKeys: string[] = []
  for (const tabId of tabIds) {
    const leafCount = 1 + Math.floor(random() * 4)
    for (let leaf = 0; leaf < leafCount; leaf += 1) {
      paneKeys.push(`${tabId}:${leafId(leaf)}`)
    }
  }
  // Malformed keys the resolvers must skip, plus a shuffle so insertion order varies.
  paneKeys.push('tab-0:not-a-uuid', 'no-colon-key', `:${leafId(0)}`, `tab-0:${leafId(0)}:extra`)
  for (let i = paneKeys.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[paneKeys[i], paneKeys[j]] = [paneKeys[j]!, paneKeys[i]!]
  }

  const statusMap: Record<string, AgentStatusEntry> = {}
  const retainedMap: Record<string, RetainedAgentEntry> = {}
  for (const paneKey of paneKeys) {
    if (random() < 0.8) {
      const state = STATES[Math.floor(random() * STATES.length)]!
      statusMap[paneKey] = statusEntry(
        paneKey,
        state,
        AGENT_TYPES[Math.floor(random() * AGENT_TYPES.length)]
      )
    }
    if (random() < 0.5) {
      const agentType = AGENT_TYPES[Math.floor(random() * AGENT_TYPES.length)] ?? 'claude'
      retainedMap[paneKey] = retainedEntry(paneKey, agentType)
    }
  }

  const probes = tabIds.concat('tab-absent').map((tabId) => {
    const roll = random()
    const layout =
      roll < 0.2
        ? undefined
        : roll < 0.35
          ? layoutOf(null)
          : roll < 0.45
            ? layoutOf('not-a-uuid')
            : layoutOf(leafId(Math.floor(random() * 5)))
    return { tabId, layout }
  })
  return { statusMap, retainedMap, probes }
}

function expectParity(testCase: RandomCase): void {
  for (const { tabId, layout } of testCase.probes) {
    const { statusMap, retainedMap } = testCase
    expect(resolveFocusedTabAgent(statusMap, layout, tabId)).toBe(
      ORACLES.focused(statusMap, layout, tabId)
    )
    expect(resolveSiblingTabAgent(statusMap, layout, tabId)).toBe(
      ORACLES.sibling(statusMap, layout, tabId)
    )
    expect(resolveFocusedCompletedTabAgent(statusMap, layout, tabId)).toBe(
      ORACLES.focusedCompleted(statusMap, layout, tabId)
    )
    expect(resolveSiblingCompletedTabAgent(statusMap, layout, tabId)).toBe(
      ORACLES.siblingCompleted(statusMap, layout, tabId)
    )
    expect(resolveFocusedRetainedTabAgent(retainedMap, layout, tabId)).toBe(
      ORACLES.focusedRetained(retainedMap, layout, tabId)
    )
    expect(resolveSiblingRetainedTabAgent(retainedMap, layout, tabId)).toBe(
      ORACLES.siblingRetained(retainedMap, layout, tabId)
    )
  }
}

describe('tab agent status index parity with the pre-index full-map scan', () => {
  it('matches the oracle across 250 randomized status maps', () => {
    const random = mulberry32(0xc0ffee)
    for (let caseIndex = 0; caseIndex < 250; caseIndex += 1) {
      expectParity(generateCase(random))
    }
  })

  it('returns the first done sibling in insertion order when siblings run different agents', () => {
    const map = {
      [`tab-1:${leafId(0)}`]: statusEntry(`tab-1:${leafId(0)}`, 'done', 'codex'),
      [`tab-1:${leafId(1)}`]: statusEntry(`tab-1:${leafId(1)}`, 'done', 'claude'),
      [`tab-1:${leafId(2)}`]: statusEntry(`tab-1:${leafId(2)}`, 'done', 'gemini')
    }
    expect(resolveSiblingCompletedTabAgent(map, layoutOf(leafId(2)), 'tab-1')).toBe('codex')
    expect(resolveSiblingCompletedTabAgent(map, layoutOf(leafId(0)), 'tab-1')).toBe('claude')
    // Fresh identity, reversed insertion order → first match flips.
    const reversed = Object.fromEntries(Object.entries(map).toReversed())
    expect(resolveSiblingCompletedTabAgent(reversed, layoutOf(leafId(2)), 'tab-1')).toBe('claude')
  })

  it('excludes the active leaf and skips non-iconable agents', () => {
    const map = {
      [`tab-1:${leafId(0)}`]: statusEntry(`tab-1:${leafId(0)}`, 'done', 'unknown'),
      [`tab-1:${leafId(1)}`]: statusEntry(`tab-1:${leafId(1)}`, 'done', 'claude'),
      [`tab-2:${leafId(2)}`]: statusEntry(`tab-2:${leafId(2)}`, 'done', 'codex')
    }
    expect(resolveSiblingCompletedTabAgent(map, layoutOf(leafId(1)), 'tab-1')).toBeNull()
    expect(resolveSiblingCompletedTabAgent(map, layoutOf(leafId(0)), 'tab-1')).toBe('claude')
  })

  it('ignores pane keys parsePaneKey rejects and empty maps', () => {
    const malformed = {
      'tab-1:not-a-uuid': statusEntry('tab-1:not-a-uuid', 'done', 'claude'),
      'tab-1': statusEntry('tab-1', 'done', 'claude'),
      [`:${leafId(0)}`]: statusEntry(`:${leafId(0)}`, 'done', 'claude')
    }
    expect(resolveFocusedCompletedTabAgent(malformed, undefined, 'tab-1')).toBeNull()
    expect(resolveSiblingCompletedTabAgent(malformed, layoutOf(leafId(9)), 'tab-1')).toBeNull()
    expect(resolveFocusedCompletedTabAgent({}, undefined, 'tab-1')).toBeNull()
    expect(resolveFocusedRetainedTabAgent({}, undefined, 'tab-1')).toBeNull()
  })

  it('re-indexes when the store replaces the map identity', () => {
    const paneKey = `tab-1:${leafId(0)}`
    const before = { [paneKey]: statusEntry(paneKey, 'done', 'claude') }
    expect(resolveFocusedCompletedTabAgent(before, undefined, 'tab-1')).toBe('claude')
    const after = { [paneKey]: statusEntry(paneKey, 'done', 'codex') }
    expect(resolveFocusedCompletedTabAgent(after, undefined, 'tab-1')).toBe('codex')
    expect(resolveFocusedCompletedTabAgent(before, undefined, 'tab-1')).toBe('claude')
  })

  it('scans each source identity once across tabs and resolver variants', () => {
    const firstPaneKey = `tab-1:${leafId(0)}`
    const secondPaneKey = `tab-2:${leafId(1)}`
    const status = countEntryScans({
      [firstPaneKey]: statusEntry(firstPaneKey, 'working', 'claude'),
      [secondPaneKey]: statusEntry(secondPaneKey, 'done', 'codex')
    })
    const retained = countEntryScans({
      [firstPaneKey]: retainedEntry(firstPaneKey, 'claude'),
      [secondPaneKey]: retainedEntry(secondPaneKey, 'codex')
    })

    for (const tabId of ['tab-1', 'tab-2', 'tab-absent']) {
      const layout = layoutOf(leafId(9))
      resolveFocusedTabAgent(status.source, undefined, tabId)
      resolveSiblingTabAgent(status.source, layout, tabId)
      resolveFocusedCompletedTabAgent(status.source, undefined, tabId)
      resolveSiblingCompletedTabAgent(status.source, layout, tabId)
      resolveFocusedRetainedTabAgent(retained.source, undefined, tabId)
      resolveSiblingRetainedTabAgent(retained.source, layout, tabId)
    }

    expect(status.scans()).toBe(1)
    expect(retained.scans()).toBe(1)

    const replacement = countEntryScans({ ...status.source })
    resolveFocusedTabAgent(replacement.source, undefined, 'tab-1')
    resolveFocusedCompletedTabAgent(replacement.source, undefined, 'tab-2')
    expect(replacement.scans()).toBe(1)
  })
})
