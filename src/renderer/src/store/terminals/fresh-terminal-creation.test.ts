import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { createStoreSessionMockApi } from '../testing/app-store-session-api.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../repos/repo.test-fixture'

const mocks = vi.hoisted(() => ({
  store: null as ReturnType<typeof createTestStore> | null,
  call: vi.fn(),
  focus: vi.fn(),
  notice: vi.fn(),
  uuid: vi.fn(),
  main: false
}))
function store() {
  if (!mocks.store) {
    throw new Error('Missing test store')
  }
  return mocks.store
}
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => store().getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      store().setState(...args),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      store().subscribe(...args)
  }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: mocks.notice } }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.main
  }
}))
vi.mock('../../../../shared/non-secure-context-uuid', () => ({
  createNonSecureContextUuid: mocks.uuid
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/lib/workspace/tabs/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.focus
}))
vi.mock('@/runtime/sync-runtime-graph/terminal-group-grid-sizes', () => ({
  measureTerminalGroupGridSizes: () => ({ groups: { source: { cols: 160, rows: 60 } } })
}))

import { createFreshTerminal } from './fresh-terminal-creation'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { projectRetainedTerminalStart } from './retained-terminal-start'
import {
  prepareRetainedTerminalStartupRestoration,
  createRetainedTerminalStartupPreparation
} from '../../startup/retained-terminal-startup-restoration'
import { detachTerminalPaneToTab } from '../../components/terminal-pane/layout/detach/terminal-pane-tab-detach'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { TerminalStartupRestoration } from '../../../../shared/workspace-layout/retained-terminal-destination'

const WORKTREE = 'repo1::/repo1/main'
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LEAF = '11111111-1111-4111-8111-111111111111'
const GROUP = '22222222-2222-4222-8222-222222222222'

function setup(main: boolean) {
  mocks.main = main
  createStoreSessionMockApi()
  mocks.store = createTestStore()
  seedStore(store(), {
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    activeWorktreeId: WORKTREE,
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/repo1/main', hostId: 'local' })]
    },
    groupsByWorktree: {
      [WORKTREE]: [{ id: 'source', worktreeId: WORKTREE, tabOrder: [], activeTabId: null }]
    },
    layoutByWorktree: { [WORKTREE]: { type: 'leaf', groupId: 'source' } },
    activeGroupIdByWorktree: { [WORKTREE]: 'source' }
  })
  mocks.uuid
    .mockReturnValueOnce(TAB)
    .mockReturnValueOnce(LEAF)
    .mockReturnValueOnce(GROUP)
    .mockReturnValue('mutation-1')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.uuid.mockReset()
})

const EXTRA_LEAF = '33333333-3333-4333-8333-333333333333'

function pendingRestoredSplit(savedBinding?: string) {
  setup(false)
  const state = store().getState()
  const tab = state.createTab(WORKTREE, 'source', undefined, {
    id: TAB,
    initialLeafId: LEAF,
    activate: false
  })
  const layout = {
    root: {
      type: 'split' as const,
      direction: 'vertical' as const,
      ratio: 0.7,
      first: { type: 'leaf' as const, leafId: LEAF },
      second: { type: 'leaf' as const, leafId: EXTRA_LEAF }
    },
    activeLeafId: LEAF,
    expandedLeafId: LEAF,
    titlesByLeafId: { [LEAF]: 'Current title' },
    buffersByLeafId: { [LEAF]: 'Keep this image' },
    lastGridsByLeafId: { [LEAF]: { cols: 101, rows: 32 } },
    ...(savedBinding ? { ptyIdsByLeafId: { [EXTRA_LEAF]: savedBinding } } : {})
  }
  state.setTabLayout(TAB, layout)
  const destination: TerminalStartupRestoration['retainedTerminalStarts'][number] = {
    start: {
      worktreeId: WORKTREE,
      executionHostId: 'local',
      runtimeId: 'runtime-1',
      tabId: TAB,
      leafId: EXTRA_LEAF,
      bindingGeneration: 0,
      startSequence: 1,
      status: 'failed',
      reason: 'The selected shell could not start.'
    },
    tab,
    layout,
    group: { id: 'source', worktreeId: WORKTREE, tabOrder: [TAB], activeTabId: TAB }
  }
  const reply = Promise.withResolvers<TerminalStartupRestoration>()
  Object.assign(window.api, { app: { prepareTerminalStartupRestoration: () => reply.promise } })
  const preparation = createRetainedTerminalStartupPreparation(() => false)
  const pending = preparation.prepare()
  return { destination, reply, pending, preparation }
}

it.each(['close', 'binding', 'newer attempt'] as const)(
  'keeps an intervening %s instead of replaying an older prepare destination',
  async (change) => {
    const { destination, reply, pending } = pendingRestoredSplit()
    const state = store().getState()
    if (change === 'close') {
      state.setTabLayout(TAB, { ...destination.layout, root: { type: 'leaf', leafId: LEAF } })
    } else if (change === 'binding') {
      state.setTabLayout(TAB, {
        ...destination.layout,
        ptyIdsByLeafId: { [EXTRA_LEAF]: 'accepted-successor' }
      })
    } else {
      expect(
        projectRetainedTerminalStart(
          { ...destination.start, startSequence: 2 },
          { splitFromLeafId: LEAF }
        )
      ).toBe(true)
    }
    const current = store().getState().terminalLayoutsByTabId[TAB]
    reply.resolve({ retainedTerminalStarts: [destination] })
    expect(await pending).toBe(true)
    expect(store().getState().terminalLayoutsByTabId[TAB]).toBe(current)
    expect(store().getState().terminalLayoutsByTabId[TAB]).toMatchObject({
      titlesByLeafId: { [LEAF]: 'Current title' },
      buffersByLeafId: { [LEAF]: 'Keep this image' },
      lastGridsByLeafId: { [LEAF]: { cols: 101, rows: 32 } }
    })
    const start =
      store().getState().terminalPaneStartsByPaneKey[`${TAB}:${EXTRA_LEAF}`]?.retainedTerminalStart
    expect(start?.startSequence).toBe(change === 'newer attempt' ? 2 : undefined)
  }
)

it('preserves a historical association across layout writes and settles only the addressed accepted same-ID binding', async () => {
  const { destination, reply, pending } = pendingRestoredSplit('saved-session')
  expect(projectRetainedTerminalStart(destination.start)).toBe(true)
  const state = store().getState()
  const before = state.terminalLayoutsByTabId[TAB]!
  state.setTabLayout(TAB, {
    ...before,
    titlesByLeafId: { ...before.titlesByLeafId, [EXTRA_LEAF]: 'Current failed pane' }
  })
  expect(store().getState().terminalPaneStartsByPaneKey[`${TAB}:${EXTRA_LEAF}`]?.status).toBe(
    'failed'
  )
  const accepted = store().getState().terminalLayoutsByTabId[TAB]!
  store().getState().setTabLayout(TAB, accepted, EXTRA_LEAF)
  expect(store().getState().terminalPaneStartsByPaneKey[`${TAB}:${EXTRA_LEAF}`]).toBeUndefined()
  reply.resolve({ retainedTerminalStarts: [destination] })
  expect(await pending).toBe(true)
  expect(store().getState().terminalLayoutsByTabId[TAB]).toBe(accepted)
  expect(store().getState().terminalPaneStartsByPaneKey[`${TAB}:${EXTRA_LEAF}`]).toBeUndefined()
})

it('transfers a restored unknown obligation through the real pane detach owner while an old prepare is in flight', async () => {
  const { destination, reply, pending } = pendingRestoredSplit()
  Object.assign(window.api.pty, { moveLeafToNewTab: vi.fn(async () => ({ status: 'not_held' })) })
  const moved = await detachTerminalPaneToTab({
    getStore: () => store().getState(),
    sourceTabId: TAB,
    sourcePaneId: 2,
    worktreeId: WORKTREE,
    targetGroupId: 'source',
    targetTabId: 'moved-tab',
    manager: {
      getPanes: () => [{ id: 1 }, { id: 2 }],
      getLeafId: () => EXTRA_LEAF,
      detachPaneForExternalMove: () => true
    },
    persistLayoutSnapshot: () => {}
  })
  expect(moved?.tab.id).toBe('moved-tab')
  reply.resolve({ retainedTerminalStarts: [destination] })
  expect(await pending).toBe(true)
  const state = store().getState()
  expect(state.terminalLayoutsByTabId[TAB]?.root).toEqual({ type: 'leaf', leafId: LEAF })
  expect(state.terminalLayoutsByTabId['moved-tab']?.root).toEqual({
    type: 'leaf',
    leafId: EXTRA_LEAF
  })
  expect(state.terminalStartupAttempt?.isUnknown(WORKTREE, 'moved-tab', EXTRA_LEAF)).toBe(true)
  expect(state.terminalPaneStartsByPaneKey[`${TAB}:${EXTRA_LEAF}`]).toBeUndefined()
})

it('does not let a disposed startup response settle its replacement attempt', async () => {
  const { destination, reply, pending, preparation } = pendingRestoredSplit()
  const replacementReply = Promise.withResolvers<TerminalStartupRestoration>()
  Object.assign(window.api, {
    app: { prepareTerminalStartupRestoration: () => replacementReply.promise }
  })
  preparation.dispose()
  const replacement = createRetainedTerminalStartupPreparation(() => false)
  const next = replacement.prepare()
  reply.resolve({ retainedTerminalStarts: [destination] })
  expect(await pending).toBe(false)
  expect(replacement.isPrepared()).toBe(false)
  expect(store().getState().terminalStartupAttempt?.isUnknown(WORKTREE, TAB, EXTRA_LEAF)).toBe(true)
  expect(store().getState().terminalPaneStartsByPaneKey).toEqual({})
  replacementReply.resolve({ retainedTerminalStarts: [] })
  expect(await next).toBe(true)
  expect(replacement.isPrepared()).toBe(true)
})

it('continues past one unresolved destination, imports later starts and retains only the unresolved automatic obligation', async () => {
  setup(false)
  const tab = store()
    .getState()
    .createTab(WORKTREE, 'source', undefined, { id: TAB, initialLeafId: LEAF, activate: false })
  const preparation = createRetainedTerminalStartupPreparation(() => false)
  const start = {
    worktreeId: WORKTREE,
    executionHostId: 'local' as const,
    runtimeId: 'runtime-1',
    tabId: TAB,
    leafId: EXTRA_LEAF,
    bindingGeneration: 0,
    startSequence: 1,
    status: 'failed' as const,
    reason: 'The shell exited.'
  }
  const unresolved: TerminalStartupRestoration['retainedTerminalStarts'][number] = {
    start,
    tab,
    layout: {
      root: { type: 'leaf', leafId: EXTRA_LEAF },
      activeLeafId: EXTRA_LEAF,
      expandedLeafId: null
    },
    group: { id: 'source', worktreeId: WORKTREE, tabOrder: [TAB], activeTabId: TAB }
  }
  const laterTab = '55555555-5555-4555-8555-555555555555'
  const laterLeaf = '66666666-6666-4666-8666-666666666666'
  const later: typeof unresolved = {
    ...unresolved,
    start: { ...start, tabId: laterTab, leafId: laterLeaf },
    tab: { ...tab, id: laterTab },
    layout: {
      root: { type: 'leaf', leafId: laterLeaf },
      activeLeafId: laterLeaf,
      expandedLeafId: null
    },
    group: { ...unresolved.group!, tabOrder: [laterTab], activeTabId: laterTab }
  }
  Object.assign(window.api, {
    app: {
      prepareTerminalStartupRestoration: async () => ({
        retainedTerminalStarts: [unresolved, later]
      })
    }
  })
  await expect(preparation.prepare()).resolves.toBe(true)
  expect(
    store()
      .getState()
      .tabsByWorktree[WORKTREE]?.map((row) => row.id)
  ).toEqual([TAB, laterTab])
  const attempt = store().getState().terminalStartupAttempt!
  expect(attempt.isUnknown(WORKTREE, TAB, LEAF)).toBe(false)
  expect(attempt.isUnknown(WORKTREE, TAB, EXTRA_LEAF)).toBe(true)
  expect(store().getState().terminalLayoutsByTabId[TAB]?.root).toEqual({
    type: 'leaf',
    leafId: LEAF
  })
  expect(store().getState().terminalPaneStartsByPaneKey[`${laterTab}:${laterLeaf}`]).toMatchObject({
    status: 'failed'
  })
  expect(preparation.isPrepared()).toBe(false)
  Object.assign(window.api.app, {
    prepareTerminalStartupRestoration: async () => ({
      retainedTerminalStarts: [
        {
          ...unresolved,
          layout: {
            root: {
              type: 'split',
              direction: 'vertical',
              ratio: 0.4,
              first: { type: 'leaf', leafId: LEAF },
              second: { type: 'leaf', leafId: EXTRA_LEAF }
            },
            activeLeafId: LEAF,
            expandedLeafId: null
          }
        },
        later
      ]
    })
  })
  await expect(preparation.prepare()).resolves.toBe(true)
  expect(preparation.isPrepared()).toBe(true)
  expect(store().getState().terminalLayoutsByTabId[TAB]?.root).toMatchObject({
    type: 'split',
    second: { leafId: EXTRA_LEAF }
  })
})

it('restores host-admitted split and new-group failures after hydration before exposing unbound destinations', async () => {
  setup(false)
  const splitLeaf = '33333333-3333-4333-8333-333333333333'
  const newTab = '44444444-4444-4444-8444-444444444444'
  const newLeaf = '55555555-5555-4555-8555-555555555555'
  const sourceTab = {
    id: TAB,
    worktreeId: WORKTREE,
    ptyId: 'pty-source',
    title: 'Source',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeWorkspaceExecutionHostId: 'local',
    activeTabId: TAB,
    activeTabIdByWorktree: { [WORKTREE]: TAB },
    tabsByWorktree: { [WORKTREE]: [sourceTab] },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-source' }
      }
    },
    remoteSessionIdsByTabId: { [TAB]: 'pty-source' },
    unifiedTabs: {
      [WORKTREE]: [
        {
          id: TAB,
          entityId: TAB,
          worktreeId: WORKTREE,
          groupId: 'source',
          contentType: 'terminal',
          label: 'Source',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      [WORKTREE]: [{ id: 'source', worktreeId: WORKTREE, activeTabId: TAB, tabOrder: [TAB] }]
    },
    tabGroupLayouts: { [WORKTREE]: { type: 'leaf', groupId: 'source' } },
    activeGroupIdByWorktree: { [WORKTREE]: 'source' }
  }
  store().getState().hydrateWorkspaceSession(session)
  store().getState().hydrateTabsSession(session)
  expect(store().getState().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({
    [LEAF]: 'pty-source'
  })
  expect(
    store()
      .getState()
      .groupsByWorktree[WORKTREE]?.map((group) => group.id)
  ).toEqual(['source'])

  const reply = Promise.withResolvers<TerminalStartupRestoration>()
  const spawn = vi.fn()
  Object.assign(window.api.pty, { spawn })
  Object.assign(window.api, {
    app: { prepareTerminalStartupRestoration: vi.fn(() => reply.promise) }
  })
  // No notifier is delivered: only the awaited prepare reply can import these admitted destinations.
  const pending = prepareRetainedTerminalStartupRestoration(() => false)
  const current = store().getState()
  const editor = {
    ...current.unifiedTabsByWorktree[WORKTREE][0],
    id: '/repo1/main/current.ts',
    entityId: '/repo1/main/current.ts',
    contentType: 'editor' as const,
    label: 'current.ts'
  }
  store().setState({
    unifiedTabsByWorktree: { [WORKTREE]: [...current.unifiedTabsByWorktree[WORKTREE], editor] },
    groupsByWorktree: {
      [WORKTREE]: [
        { id: 'source', worktreeId: WORKTREE, tabOrder: [TAB, editor.id], activeTabId: editor.id },
        { id: 'empty', worktreeId: WORKTREE, tabOrder: [], activeTabId: null }
      ]
    },
    layoutByWorktree: {
      [WORKTREE]: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.7,
        first: { type: 'leaf', groupId: 'source' },
        second: { type: 'leaf', groupId: 'empty' }
      }
    }
  })
  // A binding accepted after hydration must survive the older descriptor's source-leaf image.
  store()
    .getState()
    .setTabLayout(TAB, {
      root: { type: 'leaf', leafId: LEAF },
      activeLeafId: LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF]: 'pty-source-newer' }
    })
  const exposed = new Set<string>()
  const stop = store().subscribe((state) => {
    const root = state.terminalLayoutsByTabId[TAB]?.root
    if (root?.type === 'split' && root.second.type === 'leaf' && root.second.leafId === splitLeaf) {
      exposed.add('split')
      expect(state.terminalPaneStartsByPaneKey[`${TAB}:${splitLeaf}`]).toMatchObject({
        status: 'failed',
        retainedTerminalStart: {
          runtimeId: 'runtime-1',
          tabId: TAB,
          leafId: splitLeaf,
          startSequence: 1
        }
      })
    }
    if (
      state.tabsByWorktree[WORKTREE]?.some((tab) => tab.id === newTab) ||
      state.unifiedTabsByWorktree[WORKTREE]?.some((tab) => tab.entityId === newTab)
    ) {
      exposed.add('new-group-tab')
      expect(state.terminalPaneStartsByPaneKey[`${newTab}:${newLeaf}`]).toMatchObject({
        status: 'failed',
        retainedTerminalStart: {
          runtimeId: 'runtime-1',
          tabId: newTab,
          leafId: newLeaf,
          startSequence: 1
        }
      })
    }
    expect(state.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[LEAF]).toBe('pty-source-newer')
  })
  reply.resolve({
    retainedTerminalStarts: [
      {
        start: {
          worktreeId: WORKTREE,
          executionHostId: 'local',
          runtimeId: 'runtime-1',
          tabId: TAB,
          leafId: splitLeaf,
          bindingGeneration: 0,
          startSequence: 1,
          status: 'failed',
          reason: 'The selected shell could not start.'
        },
        tab: sourceTab,
        layout: {
          root: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', leafId: LEAF },
            second: { type: 'leaf', leafId: splitLeaf }
          },
          activeLeafId: splitLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-source' }
        },
        group: { id: 'source', worktreeId: WORKTREE, activeTabId: TAB, tabOrder: [TAB] }
      },
      {
        start: {
          worktreeId: WORKTREE,
          executionHostId: 'local',
          runtimeId: 'runtime-1',
          tabId: newTab,
          leafId: newLeaf,
          bindingGeneration: 0,
          startSequence: 1,
          status: 'failed',
          reason: 'The selected shell could not start.'
        },
        tab: {
          ...sourceTab,
          id: newTab,
          ptyId: null,
          title: 'New group',
          sortOrder: 1,
          createdAt: 2
        },
        layout: {
          root: { type: 'leaf', leafId: newLeaf },
          activeLeafId: newLeaf,
          expandedLeafId: null
        },
        group: { id: GROUP, worktreeId: WORKTREE, activeTabId: newTab, tabOrder: [newTab] },
        groupLayout: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: 'source' },
          second: { type: 'leaf', groupId: GROUP }
        }
      }
    ]
  })
  try {
    expect(await pending).toBe(true)
  } finally {
    stop()
  }
  expect([...exposed].sort()).toEqual(['new-group-tab', 'split'])
  const state = store().getState()
  expect(state.terminalLayoutsByTabId[TAB]).toMatchObject({
    root: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', leafId: LEAF },
      second: { type: 'leaf', leafId: splitLeaf }
    },
    ptyIdsByLeafId: { [LEAF]: 'pty-source-newer' }
  })
  expect(state.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[splitLeaf]).toBeUndefined()
  expect(state.terminalLayoutsByTabId[newTab]).toMatchObject({
    root: { type: 'leaf', leafId: newLeaf },
    activeLeafId: newLeaf,
    expandedLeafId: null
  })
  expect(state.terminalLayoutsByTabId[newTab]?.ptyIdsByLeafId?.[newLeaf]).toBeUndefined()
  expect(state.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([TAB, newTab])
  expect(state.unifiedTabsByWorktree[WORKTREE]).toEqual([
    expect.objectContaining({ id: TAB, entityId: TAB, groupId: 'source' }),
    editor,
    expect.objectContaining({ id: newTab, entityId: newTab, groupId: GROUP })
  ])
  expect(state.groupsByWorktree[WORKTREE]).toEqual([
    expect.objectContaining({ id: 'source', tabOrder: [TAB, editor.id], activeTabId: editor.id }),
    { id: 'empty', worktreeId: WORKTREE, tabOrder: [], activeTabId: null },
    expect.objectContaining({ id: GROUP, tabOrder: [newTab], activeTabId: newTab })
  ])
  expect(state.layoutByWorktree[WORKTREE]).toEqual({
    type: 'split',
    direction: 'vertical',
    ratio: 0.7,
    first: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', groupId: 'source' },
      second: { type: 'leaf', groupId: GROUP }
    },
    second: { type: 'leaf', groupId: 'empty' }
  })
  expect(mocks.call).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})

describe.each([false, true])('fresh host terminal (main layout = %s)', (main) => {
  it('waits for host admission before publishing a shell tab or new group, and leaves refusal unchanged', async () => {
    setup(main)
    const before = store().getState()
    let refuse!: (error: Error) => void
    mocks.call.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        })
    )
    const pending = createFreshTerminal({
      worktreeId: WORKTREE,
      shell: 'powershell.exe',
      split: { sourceGroupId: 'source', splitDirection: 'right' }
    })
    expect(store().getState().tabsByWorktree).toBe(before.tabsByWorktree)
    expect(store().getState().groupsByWorktree).toBe(before.groupsByWorktree)

    refuse(
      new Error(
        'This folder contains Git storage, not checked-out files. Open a checkout to start a terminal or chat.'
      )
    )
    expect(await pending).toBe(false)
    expect(store().getState().tabsByWorktree).toBe(before.tabsByWorktree)
    expect(store().getState().groupsByWorktree).toBe(before.groupsByWorktree)
    expect(store().getState().layoutByWorktree).toBe(before.layoutByWorktree)
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(mocks.notice).toHaveBeenCalledOnce()
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('attaches the accepted IDs once and preserves requested shell, startup bytes, placement and measured size', async () => {
    setup(main)
    mocks.call.mockResolvedValueOnce({
      terminal: { tabId: TAB, paneKey: `${TAB}:${LEAF}`, ptyId: 'pty-accepted' }
    })
    const created = await createFreshTerminal({
      worktreeId: WORKTREE,
      shell: 'powershell.exe',
      cwd: '/repo1/main/sub',
      command: 'printf "a  b"\n',
      env: { FRESH: 'yes' },
      envToDelete: ['OLD'],
      startupCommandDelivery: 'shell-ready',
      viewMode: 'chat',
      split: { sourceGroupId: 'source', splitDirection: 'right' }
    })

    expect(created).toBe(true)
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'terminal.create',
      expect.objectContaining({
        tabId: TAB,
        leafId: LEAF,
        targetGroupId: GROUP,
        split: { besideGroupId: 'source', direction: 'right' },
        initialSize: { cols: 80, rows: 60 },
        shell: 'powershell.exe',
        cwd: '/repo1/main/sub',
        command: 'printf "a  b"\n',
        env: { FRESH: 'yes' },
        envToDelete: ['OLD'],
        startupCommandDelivery: 'shell-ready',
        viewMode: 'chat',
        presentation: 'background'
      })
    )
    expect(
      store()
        .getState()
        .tabsByWorktree[WORKTREE].map((tab) => [tab.id, tab.ptyId])
    ).toEqual([[TAB, 'pty-accepted']])
    expect(store().getState().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({
      [LEAF]: 'pty-accepted'
    })
    expect(store().getState().unifiedTabsByWorktree[WORKTREE]).toEqual([
      expect.objectContaining({ entityId: TAB, groupId: GROUP, viewMode: 'chat' })
    ])
    expect(store().getState().pendingStartupByTabId[TAB]).toBeUndefined()
    expect(mocks.focus).toHaveBeenCalledWith(TAB, LEAF, expect.any(Object))
  })

  it('installs an admitted failure before mount and retires its hold only on a newer attempt or binding', async () => {
    setup(main)
    const start = {
      worktreeId: WORKTREE,
      runtimeId: 'runtime-1',
      executionHostId: 'local' as const,
      tabId: TAB,
      leafId: LEAF,
      bindingGeneration: 0,
      startSequence: 1,
      status: 'failed' as const,
      reason: 'The selected shell could not start.'
    }
    expect(projectRetainedTerminalStart({ ...start, tabId: 'another-tab' }, { tabId: TAB })).toBe(
      false
    )
    expect(store().getState().tabsByWorktree[WORKTREE] ?? []).toEqual([])
    mocks.call.mockRejectedValueOnce(
      new RuntimeRpcCallError({
        id: 'create',
        ok: false,
        error: {
          code: 'runtime_error',
          message: start.reason,
          data: { retainedTerminalStart: start }
        }
      })
    )
    let exposed = false
    const stop = store().subscribe((state) => {
      if (state.tabsByWorktree[WORKTREE]?.some((tab) => tab.id === TAB)) {
        exposed = true
        expect(state.terminalPaneStartsByPaneKey[`${TAB}:${LEAF}`]?.status).toBe('failed')
      }
    })
    expect(await createFreshTerminal({ worktreeId: WORKTREE })).toBe(true)
    stop()
    expect(exposed).toBe(true)
    expect(mocks.notice).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(store().getState().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[LEAF]).toBeUndefined()
    expect(
      projectRetainedTerminalStart({ ...start, status: 'starting', startSequence: 2, reason: '' })
    ).toBe(true)
    expect(projectRetainedTerminalStart(start)).toBe(false)
    expect(store().getState().terminalPaneStartsByPaneKey[`${TAB}:${LEAF}`]?.status).toBe(
      'starting'
    )
    store()
      .getState()
      .setTabLayout(TAB, {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'accepted-new-pty' }
      })
    expect(store().getState().terminalPaneStartsByPaneKey[`${TAB}:${LEAF}`]).toBeUndefined()
    expect(projectRetainedTerminalStart(start)).toBe(false)
  })

  it('does not launch again after a lost reply or steal a selection made while acceptance was pending', async () => {
    setup(main)
    mocks.call.mockRejectedValueOnce(new Error('Connection closed before reply'))
    expect(await createFreshTerminal({ worktreeId: WORKTREE })).toBe(false)
    expect(store().getState().tabsByWorktree[WORKTREE] ?? []).toEqual([])
    expect(mocks.call).toHaveBeenCalledOnce()

    mocks.uuid
      .mockReset()
      .mockReturnValueOnce(TAB)
      .mockReturnValueOnce(LEAF)
      .mockReturnValue('mutation-2')
    let accept!: (result: unknown) => void
    mocks.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve
        })
    )
    const pending = createFreshTerminal({ worktreeId: WORKTREE })
    store().setState({ activeTabType: 'editor', activeTabTypeByWorktree: { [WORKTREE]: 'editor' } })
    store().setState({
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WORKTREE]: 'terminal' }
    })
    accept({ terminal: { tabId: TAB, paneKey: `${TAB}:${LEAF}`, ptyId: 'pty-accepted' } })
    expect(await pending).toBe(true)
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })
})
