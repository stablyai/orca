import { resolveFocusedRetainedTabAgent } from './tab-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { makeTab, makeUnifiedTab, makeWorktree } from '@/store/slices/store-test-helpers'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { AgentStatusReadState } from '@/store/agent-status-observers'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getTabAgentExitOwner } from './tab-agent-exit-owner'
import * as signals from './tab-agent-exit-signals'
import * as projections from './terminal-agent-evidence-scopes'
import * as routing from '@/store/terminals/terminal-workspace-routing'

const leaf = '11111111-1111-4111-8111-111111111111'
const workspace = 'repo::/worktree'
const stops: (() => void)[] = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  vi.restoreAllMocks()
})

function countedRows<T>(rows: T[], count: () => void): T[] {
  rows.forEach((value, index) => {
    Object.defineProperty(rows, index, {
      get: () => {
        count()
        return value
      }
    })
  })
  return rows
}
function setup(size: number) {
  const counts = { groupLeaves: 0, rawRows: 0, unifiedRows: 0 }
  const store = createStore(createAppState),
    status = getAgentStatusOwner(store)
  const tabs = countedRows(
    Array.from({ length: size }, (_, i) =>
      makeTab({ id: `tab-${i}`, worktreeId: workspace, title: 'zsh', ptyId: `pty-${i}` })
    ),
    () => counts.rawRows++
  )
  const items = countedRows(
    tabs.map((tab, i) =>
      makeUnifiedTab({
        id: `item-${i}`,
        entityId: tab.id,
        worktreeId: workspace,
        groupId: `g${i}`,
        label: 'zsh'
      })
    ),
    () => counts.unifiedRows++
  )
  const tree = (start: number, end: number): TabGroupLayoutNode =>
    end - start === 1
      ? {
          type: 'leaf',
          get groupId() {
            counts.groupLeaves++
            return `g${start}`
          }
        }
      : {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: tree(start, Math.floor((start + end) / 2)),
          second: tree(Math.floor((start + end) / 2), end)
        }
  store.setState({
    tabsByWorktree: { [workspace]: tabs },
    unifiedTabsByWorktree: { [workspace]: items },
    worktreesByRepo: { repo: [makeWorktree({ id: workspace, repoId: 'repo' })] },
    layoutByWorktree: { [workspace]: tree(0, size) },
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: Object.fromEntries(tab.ptyId ? [[leaf, tab.ptyId]] : [])
        }
      ])
    ),
    ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, [tab.ptyId ?? '']]))
  })
  Object.assign(counts, { groupLeaves: 0, rawRows: 0, unifiedRows: 0 })
  const signal = vi.spyOn(signals, 'tabAgentExitSignals'),
    scope = vi.spyOn(projections, 'terminalAgentEvidenceScopes'),
    route = vi.spyOn(routing, 'worktreeUsesRemoteConnection')
  const reset = () => {
    Object.assign(counts, { groupLeaves: 0, rawRows: 0, unifiedRows: 0 })
    signal.mockClear()
    scope.mockClear()
    route.mockClear()
  }
  const sample = () => ({
    ...counts,
    observations: signal.mock.calls.length / 2,
    scopes: scope.mock.calls.length,
    routes: route.mock.calls.length
  })
  return { store, status, counts, reset, sample, service: getTabAgentExitOwner(status) }
}

describe('root terminal evidence production operation budgets', () => {
  it.each([10, 100])(
    'shares grouped derivation and routes actual producers at %s terminals',
    (size) => {
      const { store, counts, reset, sample, service, status } = setup(size)
      const evidence: Record<string, ReturnType<typeof sample>> = {}
      stops.push(service.start())
      evidence.seed = sample()
      expect(counts.groupLeaves).toBe(size)
      expect(evidence.seed.observations).toBe(size)
      expect(evidence.seed.unifiedRows).toBeLessThanOrEqual(size * 2)
      reset()
      store.getState().updateTabTitle('tab-0', 'first renamed')
      evidence.single = sample()
      expect(evidence.single.observations).toBe(1)
      expect(counts.groupLeaves).toBe(0)
      reset()
      store
        .getState()
        .updateTabTitles(
          Array.from({ length: size }, (_, i) => ({ tabId: `tab-${i}`, title: `renamed ${i}` }))
        )
      evidence.batch = sample()
      expect(evidence.batch.observations).toBe(size)
      expect(counts.groupLeaves).toBe(0)
      expect(evidence.batch.unifiedRows).toBeLessThanOrEqual(size * 12)
      reset()
      store.getState().setPaneForegroundAgent(makePaneKey('tab-0', leaf), {
        agent: 'codex',
        shellForeground: false
      })
      evidence.process = sample()
      expect(evidence.process.observations).toBe(1)
      expect(counts.groupLeaves).toBe(0)
      reset()
      const state = store.getState()
      store.setState({
        worktreesByRepo: {
          repo: state.worktreesByRepo.repo.map((row) => ({ ...row, displayName: 'metadata only' }))
        },
        repos: state.repos.map((row) => ({ ...row, displayName: 'metadata only' })),
        unreadTerminalTabs: { 'tab-0': true }
      })
      evidence.metadata = sample()
      expect(evidence.metadata.observations).toBe(0)
      expect(evidence.metadata.routes).toBe(0)
      expect(evidence.metadata.rawRows).toBe(0)
      reset()
      store.setState({
        repos: [
          {
            id: 'repo',
            path: '/worktree',
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-host'
          }
        ]
      })
      evidence.routing = sample()
      expect(evidence.routing.observations).toBe(size)
      expect(evidence.routing.routes).toBe(size * 2 + 2)
      expect(counts.groupLeaves).toBe(0)
      reset()
      // The getter/index sources remain warm when group helpers would return fresh synthetic leaves.
      store.setState({ layoutByWorktree: {}, activeGroupIdByWorktree: { [workspace]: 'g0' } })
      reset()
      store.getState().updateTabTitle('tab-0', 'synthetic renamed')
      expect(sample().observations).toBe(1)
      expect(counts.groupLeaves).toBe(0)
      expect(service.getObservation(workspace, 'tab-0', 'g0')).toBe(true)
      console.info('terminal-evidence-operation-counts', size, evidence)
      const transitions = vi.fn()
      const unsubscribe = status.subscribeTransitions(transitions)
      store.getState().updateTabTitle('tab-1', 'hinted title')
      expect(transitions.mock.calls.at(-1)?.[0].terminalFacts.tabsByWorktree).toEqual(['tab-1'])
      unsubscribe()
    }
  )
})

it.each([10, 100])('challenger bounds accepted/current recursive raw lookup at %s', (size) => {
  const { store, service, reset } = setup(size)
  stops.push(service.start())
  let visits = 0
  let nested = false
  const off = store.subscribe(() => {
    if (nested) {
      return
    }
    nested = true
    const current = store.getState()
    store.setState({
      tabsByWorktree: {
        [workspace]: countedRows(
          current.tabsByWorktree[workspace].map((tab, i) =>
            i === 0 ? { ...tab, title: 'nested title' } : tab
          ),
          () => visits++
        )
      }
    })
  })
  stops.push(off)
  const first = countedRows(
    store.getState().tabsByWorktree[workspace].map((tab) => ({ ...tab, title: 'outer title' })),
    () => visits++
  )
  reset()
  store.setState({ tabsByWorktree: { [workspace]: first } })
  console.info('recursive-raw-id-visits', size, visits)
  expect(visits).toBeLessThanOrEqual(size * 30)
})

it.each([10, 100])('challenger bounds accepted/current recursive status index at %s', (size) => {
  const { store, service, status } = setup(size)
  const entry = (i: number, prompt: string) => ({
    paneKey: makePaneKey(`tab-${i}`, leaf),
    agentType: 'codex' as const,
    state: 'working' as const,
    prompt,
    stateHistory: [],
    stateStartedAt: 1,
    updatedAt: 2
  })
  status.transact((tx) => {
    for (let i = 0; i < size; i++) {
      tx.setEntry(makePaneKey(`tab-${i}`, leaf), entry(i, 'initial'))
    }
  })
  stops.push(service.start())
  const sources = new Set<object>()
  let scans = 0
  const realEntries = Object.entries
  vi.spyOn(Object, 'entries').mockImplementation((obj) => {
    if (sources.has(obj)) {
      scans++
    }
    return realEntries(obj)
  })
  let nested = false
  const off = store.subscribe(() => {
    if (nested) {
      return
    }
    nested = true
    sources.add(status.getSnapshot())
    status.transact((tx) => tx.setEntry(makePaneKey('tab-0', leaf), entry(0, 'nested')))
    sources.add(status.getSnapshot())
  })
  stops.push(off)
  status.transact((tx) => {
    for (let i = 0; i < size; i++) {
      tx.setEntry(makePaneKey(`tab-${i}`, leaf), entry(i, 'outer'))
    }
    store.setState({ agentStatusEpoch: 123 })
  })
  console.info('recursive-live-source-scans', size, scans)
  expect(scans).toBeLessThanOrEqual(4)
})

it('challenger captures current status before an app updater installation', () => {
  const { store, status } = setup(10)
  const pane = makePaneKey('tab-0', leaf)
  const working = {
    paneKey: pane,
    agentType: 'codex' as const,
    state: 'working' as const,
    prompt: 'task',
    stateHistory: [],
    stateStartedAt: 1,
    updatedAt: 2
  }
  status.transact((tx) => tx.setEntry(pane, working))
  const pairs: unknown[] = []
  const off = status.subscribeTransitions((t) =>
    pairs.push({
      previous: t.previous.agentStatusByPaneKey[pane]?.state,
      next: t.next.agentStatusByPaneKey[pane]?.state,
      previousEpoch: t.previous.agentStatusEpoch,
      nextEpoch: t.next.agentStatusEpoch
    })
  )
  stops.push(off)
  store.setState(() => {
    status.transact((tx) => tx.setEntry(pane, { ...working, state: 'done' }))
    return { agentStatusEpoch: 123 }
  })
  expect(pairs).toEqual([
    { previous: 'working', next: 'done', previousEpoch: 0, nextEpoch: 0 },
    { previous: 'done', next: 'done', previousEpoch: 0, nextEpoch: 123 }
  ])
})

it.each([10, 100])('bounds retained reentry across two stores at %s tabs', (size) => {
  const { store, status, service } = setup(size)
  const other = createStore(createAppState),
    otherStatus = getAgentStatusOwner(other)
  const retained = (prompt: string) =>
    Object.fromEntries(
      Array.from({ length: size }, (_, i) => {
        const key = makePaneKey(`tab-${i}`, leaf)
        return [
          key,
          {
            worktreeId: workspace,
            tab: makeTab({ id: `tab-${i}`, worktreeId: workspace }),
            agentType: 'codex' as const,
            startedAt: 1,
            entry: {
              paneKey: key,
              state: 'done' as const,
              agentType: 'codex' as const,
              prompt,
              stateHistory: [],
              stateStartedAt: 1,
              updatedAt: 2
            }
          }
        ]
      })
    )
  store.setState({ retainedAgentsByPaneKey: retained('initial') })
  other.setState({ retainedAgentsByPaneKey: retained('other store') })
  stops.push(service.start())
  const sources = new Set<object>()
  const scans = new Map<object, number>()
  const entries = Object.entries
  vi.spyOn(Object, 'entries').mockImplementation((source) => {
    if (sources.has(source)) {
      scans.set(source, (scans.get(source) ?? 0) + 1)
    }
    return entries(source)
  })
  let nested = false
  stops.push(
    store.subscribe(() => {
      if (nested) {
        return
      }
      nested = true
      sources.add(status.getState().retainedAgentsByPaneKey)
      store.setState({ retainedAgentsByPaneKey: retained('nested') })
      sources.add(status.getState().retainedAgentsByPaneKey)
    })
  )
  const outer = retained('outer')
  sources.add(outer)
  store.setState({ retainedAgentsByPaneKey: outer })
  const { retainedAgentsByPaneKey: a } = status.getState()
  const { retainedAgentsByPaneKey: b } = otherStatus.getState()
  const old = retained('third source')
  sources.add(a)
  sources.add(b)
  sources.add(old)
  for (const source of [a, b, a, old, a]) {
    for (let i = 0; i < size; i++) {
      expect(resolveFocusedRetainedTabAgent(source, undefined, `tab-${i}`)).toBe('codex')
    }
  }
  console.info('retained-two-store-source-scans', size, [...scans.values()])
  for (const count of scans.values()) {
    expect(count).toBe(1)
  }
})

import { affectedExitEvidenceTabs as round2Affected } from '@/lib/tab-agent-exit-inputs'
it.each(['__proto__', 'constructor'])('round2 prototype raw addition %s is lossless', (id) => {
  const store = createStore(createAppState)
  const status = getAgentStatusOwner(store)
  const previous = status.getState()
  store.setState({
    tabsByWorktree: Object.fromEntries([[id, [makeTab({ id: 'prototype-tab', worktreeId: id })]]])
  })
  const next = status.getState()
  let affected: ReadonlySet<string> = new Set()
  expect(() => {
    affected = round2Affected({
      previous,
      next,
      changedKeys: new Set(),
      sequence: 0,
      terminalFacts: {}
    })
  }).not.toThrow()
  expect([...affected]).toContain('prototype-tab')
})
it.each(['__proto__', 'constructor'])('round2 prototype unified addition %s is lossless', (id) => {
  const store = createStore(createAppState)
  const status = getAgentStatusOwner(store)
  const previous = status.getState()
  store.setState({
    unifiedTabsByWorktree: Object.fromEntries([
      [
        id,
        [
          makeUnifiedTab({
            id: 'prototype-item',
            entityId: 'prototype-tab',
            worktreeId: id,
            groupId: 'g'
          })
        ]
      ]
    ])
  })
  const next = status.getState()
  let affected: ReadonlySet<string> = new Set()
  expect(() => {
    affected = round2Affected({
      previous,
      next,
      changedKeys: new Set(),
      sequence: 0,
      terminalFacts: {}
    })
  }).not.toThrow()
  expect([...affected]).toContain('prototype-tab')
})
it.each(['__proto__', 'constructor'])('round2 prototype raw removal %s is lossless', (id) => {
  const store = createStore(createAppState)
  const status = getAgentStatusOwner(store)
  store.setState({
    tabsByWorktree: Object.fromEntries([[id, [makeTab({ id: 'prototype-tab', worktreeId: id })]]])
  })
  const previous = status.getState()
  store.setState({ tabsByWorktree: {} })
  const next = status.getState()
  let affected: ReadonlySet<string> = new Set()
  expect(() => {
    affected = round2Affected({
      previous,
      next,
      changedKeys: new Set(),
      sequence: 0,
      terminalFacts: {}
    })
  }).not.toThrow()
  expect([...affected]).toContain('prototype-tab')
})
it.each(['__proto__', 'constructor'])('round2 prototype unified removal %s is lossless', (id) => {
  const store = createStore(createAppState)
  const status = getAgentStatusOwner(store)
  store.setState({
    unifiedTabsByWorktree: Object.fromEntries([
      [
        id,
        [
          makeUnifiedTab({
            id: 'prototype-item',
            entityId: 'prototype-tab',
            worktreeId: id,
            groupId: 'g'
          })
        ]
      ]
    ])
  })
  const previous = status.getState()
  store.setState({ unifiedTabsByWorktree: {} })
  const next = status.getState()
  let affected: ReadonlySet<string> = new Set()
  expect(() => {
    affected = round2Affected({
      previous,
      next,
      changedKeys: new Set(),
      sequence: 0,
      terminalFacts: {}
    })
  }).not.toThrow()
  expect([...affected]).toContain('prototype-tab')
})
import { getCachedTerminalTabForWorktree as round2Lookup } from '@/components/terminal-pane/terminal-tab-lookup'
it.each(['__proto__', 'constructor'])('round2 prototype absent raw lookup %s is empty', (id) => {
  expect(round2Lookup({}, id, 'prototype-tab')).toBeNull()
})
it('round2 prototype actual root service records a newly published agent signal', () => {
  const id = '__proto__'
  const store = createStore(createAppState)
  const status = getAgentStatusOwner(store)
  store.setState({
    layoutByWorktree: { [id]: { type: 'leaf', groupId: 'g' } },
    groupsByWorktree: { [id]: [] },
    activeGroupIdByWorktree: { [id]: 'g' }
  })
  const service = getTabAgentExitOwner(status)
  stops.push(service.start())
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.setState({
    tabsByWorktree: {
      [id]: [makeTab({ id: 'prototype-tab', worktreeId: id, title: 'codex', launchAgent: 'codex' })]
    }
  })
  expect(warn).not.toHaveBeenCalled()
  expect(service.getObservation(id, 'prototype-tab')).toBe(true)
})

it.each(['__proto__', 'constructor'])(
  'round2 prototype companions and group/layout discovery %s are own-only',
  (id) => {
    const store = createStore(createAppState)
    const status = getAgentStatusOwner(store)
    const previous = status.getState()
    const next: AgentStatusReadState = {
      ...previous,
      layoutByWorktree: { [id]: { type: 'leaf', groupId: 'group' } },
      groupsByWorktree: { [id]: [] },
      activeGroupIdByWorktree: { [id]: 'group' }
    }
    expect(() =>
      round2Affected({ previous, next, changedKeys: new Set(), sequence: 0, terminalFacts: {} })
    ).not.toThrow()
    const terminal = makeTab({
      id: 'prototype-tab',
      worktreeId: id,
      title: 'codex',
      launchAgent: 'codex'
    })
    store.setState({ tabsByWorktree: { [id]: [terminal] } })
    const service = getTabAgentExitOwner(status)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => stops.push(service.start())).not.toThrow()
    expect(service.getObservation(id, terminal.id)).toBe(true)
    const before = status.getState()
    const after = { ...before, groupsByWorktree: { [id]: [] } }
    expect([
      ...round2Affected({
        previous: before,
        next: after,
        changedKeys: new Set(),
        sequence: 0,
        terminalFacts: {}
      })
    ]).toContain(terminal.id)
    expect(warn).not.toHaveBeenCalled()
  }
)

it('round2 prototype cached unified candidates reject inherited array aliases', async () => {
  const { getCachedUnifiedTerminalTabCandidates } =
    await import('@/components/terminal-pane/terminal-unified-tab-lookup')
  const item = makeUnifiedTab({ id: 'own', entityId: 'terminal', worktreeId: 'own', groupId: 'g' })
  const source = { own: [item] }
  expect(getCachedUnifiedTerminalTabCandidates(source, 'own', 'terminal')).toEqual([item])
  const inherited: typeof source = Object.create(source)
  expect(getCachedUnifiedTerminalTabCandidates(inherited, 'own', 'terminal')).toEqual([])
})

it.each(['__proto__', 'constructor'])(
  'round2 prototype root ignores inherited group/layout scopes %s',
  (id) => {
    const store = createStore(createAppState)
    const status = getAgentStatusOwner(store)
    const tab = makeTab({
      id: 'inherited-layout',
      worktreeId: id,
      title: 'zsh',
      launchAgent: 'codex'
    })
    store.setState({
      tabsByWorktree: { [id]: [tab] },
      unifiedTabsByWorktree: {
        [id]: [
          makeUnifiedTab({
            id: 'item',
            entityId: tab.id,
            worktreeId: id,
            groupId: 'g',
            label: 'codex'
          })
        ]
      },
      layoutByWorktree: Object.create({ [id]: { type: 'leaf', groupId: 'g' } }),
      activeGroupIdByWorktree: Object.create({ [id]: 'g' }),
      groupsByWorktree: Object.create({ [id]: [{ id: 'g' }] })
    })
    const service = getTabAgentExitOwner(status)
    expect(() => stops.push(service.start())).not.toThrow()
    expect(service.getObservation(id, tab.id, 'g')).toBe(false)
    expect(service.getObservation(id, tab.id)).toBe(false)
  }
)
