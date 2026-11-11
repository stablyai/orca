import { buildWorktreeOccurrencePlan } from '../../../../shared/worktree-occurrence-plan'
import { appendWorktreeRows } from '../../../../shared/sidebar-list/row-builders'
import type { Row } from '../../../../shared/sidebar-list/row-types'
import { getWorktreeLineageGroupKey } from '../../../../shared/sidebar-list/group-keys'
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  collectLineageSlotTargets,
  selectCollapsedLineageSlots,
  selectLineageLatestAt
} from './worktree-card-slot-rollup'
import { slotTargetsOfKind, workspaceUnreadTarget } from './worktree-card-slot-targets'
import { fromLineageSlotRecord } from './worktree-card-slot-summary'

function collapsedSlot(...args: Parameters<typeof selectCollapsedLineageSlots>) {
  return fromLineageSlotRecord(selectCollapsedLineageSlots(...args))[0] ?? null
}

const original = useAppStore.getState()
const LEAF = '11111111-1111-4111-8111-111111111111'
const identity = composeWorktreeHostIdentity('local', 'child')
const pane = (tab: string) => makePaneKey(tab, LEAF)
function entry(tab: string, patch: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: pane(tab),
    worktreeId: 'child',
    state: 'working',
    agentType: 'claude',
    prompt: '',
    updatedAt: 2_000_000,
    stateStartedAt: 1_900_000,
    stateHistory: [],
    ...patch
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  useAppStore.setState({
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    agentStatusEpoch: 1,
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    worktreesByRepo: {},
    repos: []
  })
})
afterEach(() => {
  useAppStore.setState(original, true)
  vi.useRealTimers()
})

it('includes migration blocks, terminal-derived agents and blocked subagents in hidden-workspace targets', () => {
  useAppStore.setState({
    tabsByWorktree: {
      child: ['migration', 'terminal', 'parent'].map((id) =>
        makeTab({ id, worktreeId: 'child', title: id === 'terminal' ? '⠋ Claude Code' : '' })
      )
    },
    migrationUnsupportedByPtyId: {
      unsupported: {
        ptyId: 'unsupported',
        paneKey: pane('migration'),
        reason: 'legacy-numeric-pane-key',
        source: 'local',
        updatedAt: 1_800_000
      }
    },
    agentStatusByPaneKey: {
      [pane('parent')]: entry('parent', {
        subagents: [{ id: 'worker', agentType: 'codex', state: 'blocked', startedAt: 1_950_000 }]
      })
    },
    runtimePaneTitlesByTabId: { terminal: { 1: '⠋ Claude Code' } },
    ptyIdsByTabId: { terminal: ['terminal-pty'] },
    terminalLayoutsByTabId: {
      terminal: { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    }
  })
  const state = useAppStore.getState()
  const targets = collectLineageSlotTargets(state, [identity])
  expect(collapsedSlot(state, [identity])).toEqual({ kind: 'needs', count: 2 })
  expect(
    targets
      .filter((target) => target.kind === 'needs')
      .map((target) => target.paneKey)
      .sort()
  ).toEqual([pane('migration'), pane('parent')])
  expect(targets.find((target) => target.paneKey === pane('terminal'))?.kind).toBe('working')
})

it('isolates colliding workspace IDs by host and keeps their targets distinct', () => {
  useAppStore.setState({
    agentStatusByPaneKey: {
      [pane('remote')]: entry('remote', { state: 'blocked', connectionId: 'box' }),
      [pane('local')]: entry('local')
    }
  })
  const state = useAppStore.getState()
  const local = collectLineageSlotTargets(state, [identity])
  const remote = collectLineageSlotTargets(state, [composeWorktreeHostIdentity('ssh:box', 'child')])
  expect(local.map((target) => [target.kind, target.executionHostId])).toEqual([
    ['working', 'local']
  ])
  expect(remote.map((target) => [target.kind, target.executionHostId])).toEqual([
    ['needs', 'ssh:box']
  ])
  const marks = slotTargetsOfKind(
    [workspaceUnreadTarget('child', 1, 'local'), workspaceUnreadTarget('child', 2, 'ssh:box')],
    'unread'
  )
  expect(marks.map((target) => target.executionHostId)).toEqual(['ssh:box', 'local'])
})

it('expires hidden working evidence on the same freshness tick as agent rows', () => {
  useAppStore.setState({
    tabsByWorktree: { child: [makeTab({ id: 'parent', worktreeId: 'child', title: '' })] },
    agentStatusByPaneKey: { [pane('parent')]: entry('parent') }
  })
  expect(collapsedSlot(useAppStore.getState(), [identity])?.kind).toBe('working')
  vi.setSystemTime(20_000_000)
  useAppStore.setState({ agentStatusEpoch: 2 })
  expect(collapsedSlot(useAppStore.getState(), [identity])).toBeNull()
})

it('updates hidden subtree attention after status changes, acknowledgement, and freshness expiry', () => {
  const parent = makeWorktree({ id: 'parent', repoId: 'repo1', hostId: 'local', lastActivityAt: 0 })
  const child = makeWorktree({ id: 'child', repoId: 'repo1', hostId: 'local', lastActivityAt: 0 })
  const grandchild = makeWorktree({
    id: 'grandchild',
    repoId: 'repo1',
    hostId: 'local',
    lastActivityAt: 1_950_000
  })
  const plan = buildWorktreeOccurrencePlan({
    rows: [parent, child, grandchild],
    identityOf: (row) => composeWorktreeHostIdentity(row.hostId, row.id),
    childrenByParentIdentity: new Map([
      [composeWorktreeHostIdentity('local', 'parent'), [child]],
      [composeWorktreeHostIdentity('local', 'child'), [grandchild]]
    ]),
    isPinned: () => false,
    duplicatePinned: false,
    sectionsOf: ({ natural }) => [{ key: 'all', items: natural }]
  })
  const rows: Row[] = []
  appendWorktreeRows(rows, () => undefined, plan, {
    collapsedGroups: new Set([getWorktreeLineageGroupKey(parent)]),
    groupDepth: 0,
    sectionKey: 'all'
  })
  expect(rows).toHaveLength(1)
  const parentRow = rows[0]!
  if (parentRow.type !== 'item' || !parentRow.lineageDescendantIdentities) {
    throw new Error('Collapsed parent must carry its descendants')
  }
  const source = parentRow.lineageDescendantIdentities
  useAppStore.setState({
    worktreesByRepo: { repo1: [parent, child, grandchild] },
    tabsByWorktree: { grandchild: [makeTab({ id: 'agent', worktreeId: 'grandchild', title: '' })] },
    agentStatusByPaneKey: { [pane('agent')]: entry('agent', { worktreeId: 'grandchild' }) }
  })
  expect(selectLineageLatestAt(useAppStore.getState(), source)).toBe(1_950_000)
  expect(collapsedSlot(useAppStore.getState(), source)?.kind).toBe('working')
  useAppStore.setState({
    agentStatusByPaneKey: {
      [pane('agent')]: entry('agent', { worktreeId: 'grandchild', state: 'blocked' })
    },
    agentStatusEpoch: 2
  })
  expect(collapsedSlot(useAppStore.getState(), source)).toEqual({
    kind: 'needs',
    count: 1
  })
  useAppStore.setState({
    agentStatusByPaneKey: {
      [pane('agent')]: entry('agent', { worktreeId: 'grandchild', state: 'done' })
    },
    agentStatusEpoch: 3
  })
  expect(collapsedSlot(useAppStore.getState(), source)).toEqual({
    kind: 'unread',
    at: 1_900_000,
    manual: false
  })
  useAppStore.setState({ acknowledgedAgentsByPaneKey: { [pane('agent')]: 1_900_000 } })
  expect(collapsedSlot(useAppStore.getState(), source)).toBeNull()
  useAppStore.setState({
    agentStatusByPaneKey: { [pane('agent')]: entry('agent', { worktreeId: 'grandchild' }) },
    agentStatusEpoch: 4
  })
  expect(collapsedSlot(useAppStore.getState(), source)?.kind).toBe('working')
  vi.setSystemTime(20_000_000)
  useAppStore.setState({ agentStatusEpoch: 5 })
  expect(collapsedSlot(useAppStore.getState(), source)).toBeNull()
})

it('refreshes unstamped structured agent summaries when workspace ownership changes', () => {
  const tab = makeUnifiedTab({
    id: 'legacy-native',
    entityId: 'session',
    worktreeId: 'child',
    groupId: 'group',
    contentType: 'agent-session',
    agentSessionAgent: 'claude'
  })
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const remoteIdentity = composeWorktreeHostIdentity('runtime:box', 'child')
  useAppStore.setState({
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    worktreesByRepo: { repo1: [makeWorktree({ id: 'child', repoId: 'repo1' })] },
    unifiedTabsByWorktree: { child: [tab] },
    runtimeEnvironments: [publicRuntimeEnvironment({ id: 'box' })],
    agentStatusByPaneKey: { [paneKey]: entry('legacy-native', { paneKey, state: 'blocked' }) }
  })
  expect(collapsedSlot(useAppStore.getState(), [identity])).toEqual({
    kind: 'needs',
    count: 1
  })
  expect(collapsedSlot(useAppStore.getState(), [remoteIdentity])).toBeNull()
  useAppStore.setState({ repos: [{ ...TEST_REPO, executionHostId: 'runtime:box' }] })
  expect(collapsedSlot(useAppStore.getState(), [identity])).toBeNull()
  expect(collapsedSlot(useAppStore.getState(), [remoteIdentity])).toEqual({
    kind: 'needs',
    count: 1
  })
})
