import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-sync/tracking-mappings'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import { setWebRuntimeTabProps } from './web-runtime-terminal-actions'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab
} from './web-runtime-session-tab-lifecycle'
import { moveWebRuntimeSessionTab } from './web-runtime-session-tab-move'
import { buildPlainCreateTerminalParams } from './web-runtime-plain-terminal-create-params'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'
import {
  ENV,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('../store', () => ({
  useAppStore: { setState: vi.fn(), getState: () => store.state, subscribe: vi.fn() }
}))

const GROUP = 'host-group-1'
type Row = RuntimeMobileSessionTabsResult['tabs'][number]

function terminalRow(terminalId: string, hostTabId?: string): Row {
  return {
    type: 'terminal',
    id: `${terminalId}::${LEAF_ID}`,
    title: terminalId,
    parentTabId: terminalId,
    leafId: LEAF_ID,
    isActive: true,
    status: 'ready',
    terminal: `handle-${terminalId}`,
    ...(hostTabId ? { logicalTabId: hostTabId } : {})
  }
}

function chatRow(sessionId: string, rowId: string, hostTabId?: string): Row {
  return {
    type: 'agent-session',
    id: rowId,
    ...(hostTabId ? { logicalTabId: hostTabId } : {}),
    title: 'Codex',
    sessionId,
    agent: 'codex',
    isActive: true
  }
}

function apply(
  state: WebSessionTabsSyncState,
  rows: Row[],
  version: number,
  environmentId = ENV
): WebSessionTabsSyncState {
  const order = rows.map((row) => (row.type === 'terminal' ? row.parentTabId : row.id))
  return {
    ...state,
    ...applyWebSessionTabsSnapshot(
      state,
      makeSnapshot(rows, {
        snapshotVersion: version,
        tabGroups: [{ id: GROUP, activeTabId: order[0] ?? null, tabOrder: order }]
      }),
      environmentId,
      NOW
    )
  }
}

/** A client restart: the saved tabs go through the session file and every module map is lost. */
function restart(state: WebSessionTabsSyncState, edit: (tab: Tab) => Tab = (tab) => tab) {
  const parsed = parseWorkspaceSession(
    JSON.parse(
      JSON.stringify({
        ...getDefaultWorkspaceSession(),
        unifiedTabs: { [WT]: state.unifiedTabsByWorktree[WT]!.map(edit) }
      })
    )
  )
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  const saved = parsed.value
  resetWebSessionTabsSyncTestState()
  return { ...state, unifiedTabsByWorktree: { [WT]: saved.unifiedTabs![WT]! } }
}

/** What a build that drops the association saves. */
const withoutAssociation = (tab: Tab): Tab => {
  const { mirroredHostTab, ...rest } = tab
  void mirroredHostTab
  return rest
}

const pin = (state: WebSessionTabsSyncState, id: string): WebSessionTabsSyncState => ({
  ...state,
  unifiedTabsByWorktree: {
    [WT]: state.unifiedTabsByWorktree[WT]!.map((tab) =>
      tab.id === id ? { ...tab, isPinned: true } : tab
    )
  }
})

const onlyTab = (state: WebSessionTabsSyncState) => {
  expect(state.unifiedTabsByWorktree[WT]).toHaveLength(1)
  return state.unifiedTabsByWorktree[WT]![0]!
}

beforeEach(() => resetWebSessionTabsSyncTestState())

// Whatever a host tab first showed here, a host switch while this client was closed keeps its tab.
it.each([
  [
    'a chat',
    chatRow('chat-1', 'agent-session:chat-1', 'host-T'),
    terminalRow('terminal-E', 'host-T')
  ],
  ['a terminal', terminalRow('host-T'), chatRow('chat-1', 'agent-session:chat-1', 'host-T')],
  [
    'a reopened chat',
    chatRow('chat-1', 'agent-chat-tab-v1-U'),
    terminalRow('terminal-E', 'agent-chat-tab-v1-U')
  ]
])(
  'a host tab first seen as %s keeps its tab and pin through a restart and a switch',
  (_, first, next) => {
    let state = apply(makeState(), [first], 1)
    const tab = onlyTab(state)
    state = restart(pin(state, tab.id))
    state = apply(state, [next], 2)
    expect(onlyTab(state)).toMatchObject({ id: tab.id, isPinned: true, contentType: next.type })
  }
)

// A tab saved before the association adopts it once, under its own id; a reopened chat's tab
// keeps the id this client gave it, which is not the host's.
it('adopts a tab saved before the association by what it holds, keeping its id', () => {
  let state = apply(makeState(), [chatRow('chat-1', 'agent-chat-tab-v1-U')], 1)
  const id = onlyTab(state).id
  expect(id).toBe('structured-agent-session-chat-1')
  state = restart(pin(state, id), withoutAssociation)
  state = apply(state, [chatRow('chat-1', 'agent-chat-tab-v1-U')], 2)
  expect(onlyTab(state)).toMatchObject({
    id,
    isPinned: true,
    mirroredHostTab: { tabId: 'agent-chat-tab-v1-U' }
  })
  state = apply(restart(state), [terminalRow('terminal-E', 'agent-chat-tab-v1-U')], 3)
  expect(onlyTab(state)).toMatchObject({ id, isPinned: true, contentType: 'terminal' })
})

// A build that drops the association (an older one) finds a never-switched tab by its id form, as
// it always did: never-switched tabs keep the ids older builds gave them.
it('gives a never-switched tab the id an older build gives it, so one that drops the association finds it', () => {
  let state = apply(makeState(), [terminalRow('host-tab-1')], 1)
  expect(onlyTab(state).id).toBe(toWebTerminalSurfaceTabId('host-tab-1'))
  state = restart(state, withoutAssociation)
  state = apply(state, [terminalRow('host-tab-1')], 2)
  expect(onlyTab(state)).toMatchObject({
    id: toWebTerminalSurfaceTabId('host-tab-1'),
    mirroredHostTab: { tabId: 'host-tab-1' }
  })
})

// Two hosts may publish the same layout id into one workspace here: each keeps its own tab, and a
// command on either reaches its own host.
it('keeps two hosts’ tabs with equal layout ids apart, each addressing its own host', () => {
  let state = apply(makeState(), [terminalRow('one', 'same')], 1)
  state = apply(state, [terminalRow('two', 'same')], 1, 'host-two')
  const tabs = state.unifiedTabsByWorktree[WT]!
  expect(new Set(tabs.map((tab) => tab.id)).size).toBe(2)
  for (const [environmentId, terminal] of [
    [ENV, 'one'],
    ['host-two', 'two']
  ] as const) {
    const tab = tabs.find((entry) => entry.entityId === toWebTerminalSurfaceTabId(terminal))!
    expect(
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId,
        worktreeId: WT,
        tabId: tab.id
      })
    ).toBe(terminal)
  }
})

// After a restart, before any frame from the host: a command on a host tab first seen as a chat,
// which a host switch since gave a terminal, and on a second host's tab with the same layout id as
// another host's, names each host tab as that host does.
it('names the host tab in every command on a tab it mirrors, before any frame after a restart', async () => {
  let state = apply(makeState(), [chatRow('chat-1', 'agent-session:chat-1', 'host-T')], 1)
  state = apply(state, [terminalRow('terminal-E', 'host-T')], 2)
  state = apply(state, [terminalRow('one', 'same')], 1, 'host-two-a')
  state = apply(state, [terminalRow('two', 'same')], 1, 'host-two')
  state = restart(state)
  const tabs = state.unifiedTabsByWorktree[WT]!
  const switched = tabs.find((tab) => tab.mirroredHostTab?.tabId === 'host-T')!
  const suffixed = tabs.find((tab) => tab.mirroredHostTab?.hostId === 'runtime:host-two')!
  expect(switched).toMatchObject({ id: 'structured-agent-session-chat-1', contentType: 'terminal' })
  // A new tab takes its terminal's own id, so equal layout ids from two hosts never meet.
  expect(suffixed.id).toBe(toWebTerminalSurfaceTabId('two'))
  store.state = {
    ...state,
    settings: { activeRuntimeEnvironmentId: ENV },
    groupsByWorktree: { [WT]: [{ id: 'g', tabOrder: tabs.map((tab) => tab.id) }] },
    repos: [{ id: 'repo', executionHostId: `runtime:${ENV}` }],
    worktreesByRepo: {
      repo: [{ id: WT, repoId: 'repo', hostId: `runtime:${ENV}`, runtimeOwnerEnvironmentId: ENV }]
    }
  }
  const call = vi.fn(async (_request: { method: string; params: Record<string, unknown> }) => ({
    id: 'r',
    ok: true,
    result: {}
  }))
  stubRuntimeEnvironmentBridge({ call })
  const sent = (method: string) =>
    call.mock.calls.filter(([request]) => request.method === method).map(([r]) => r.params)

  for (const [environmentId, tab, hostTabId] of [
    [ENV, switched, 'terminal-E'],
    ['host-two', suffixed, 'two']
  ] as const) {
    call.mockClear()
    const named = { worktreeId: WT, tabId: tab.id, environmentId }
    await activateWebRuntimeSessionTab(named)
    await closeWebRuntimeSessionTab({ ...named, reason: 'user' })
    await moveWebRuntimeSessionTab({
      ...named,
      kind: 'move-to-group',
      targetGroupId: 'g',
      index: 0
    })
    expect(sent('session.tabs.activate')[0]).toMatchObject({ tabId: hostTabId })
    expect(sent('session.tabs.close')[0]).toMatchObject({ tabId: hostTabId })
    expect(sent('session.tabs.move')[0]).toMatchObject({ tabId: hostTabId })
    expect(
      await buildPlainCreateTerminalParams(environmentId, { worktreeId: WT, afterTabId: tab.id })
    ).toMatchObject({ afterTabId: hostTabId })
  }
  call.mockClear()
  expect(setWebRuntimeTabProps({ worktreeId: WT, tabId: switched.id, isPinned: true })).toBe(true)
  await vi.waitFor(() =>
    expect(sent('session.tabs.setTabProps')[0]).toMatchObject({ tabId: 'terminal-E' })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetWebSessionCloseIntentForTests()
})
