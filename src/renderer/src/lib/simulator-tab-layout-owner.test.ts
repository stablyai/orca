// @vitest-environment happy-dom

// With ORCA_LAYOUT_OWNER=main, a simulator tab's open and close reach main as commands, so the
// window's next save changes nothing in main's model (what the save-divergence detector checks).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeWorktree,
  runtimeOwnedRepoState,
  seedStore
} from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'

type LayoutLoad = ReturnType<typeof loadWorkspaceLayoutWithoutReport>

type Mocks = {
  layoutOwnerIsMain: boolean
  store: ReturnType<typeof createTestStore> | null
  main: LayoutLoad | null
  sent: LayoutCommand[]
}

const mocks = vi.hoisted((): Mocks => ({
  layoutOwnerIsMain: true,
  store: null,
  main: null,
  sent: []
}))

vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(
    async (_target: unknown, method: string, params?: { command?: LayoutCommand }) => {
      if (method !== 'layout.apply' || !params?.command) {
        return {}
      }
      mocks.sent.push(params.command)
      const main = mainLoad()
      // As runtime-layout-apply.ts: the window already confirmed its close, so main forces it.
      const command: LayoutCommand =
        params.command.type === 'closeTabs' ? { ...params.command, force: true } : params.command
      const applied = applyLayoutCommand(main.layout, command, {
        mintId: createBrowserUuid,
        mintLeafId: createBrowserUuid,
        now: Date.now
      })
      if (!applied.ok) {
        return { ok: false, code: applied.code }
      }
      mocks.main = { ...main, layout: applied.model }
      return { ok: true, result: applied.result }
    }
  )
}))

createStoreCascadesMockApi()

import { ensureSimulatorTab } from './ensure-simulator-tab'

const WORKTREE = 'repo1::/path/wt'
const TERMINAL = 'terminal-1'
const GROUP = 'group-1'

function store(): ReturnType<typeof createTestStore> {
  if (!mocks.store) {
    throw new Error('store not seeded')
  }
  return mocks.store
}

function mainLoad(): LayoutLoad {
  if (!mocks.main) {
    throw new Error('main not loaded')
  }
  return mocks.main
}

function loadWindowSave(): LayoutLoad {
  return loadWorkspaceLayoutWithoutReport(
    LOCAL_EXECUTION_HOST_ID,
    buildWorkspaceSessionPayload(store().getState()),
    nameBasedLoadContext()
  )
}

/** The workspace as the window's save would give it to main, beside main's stored copy. */
function expectSaveTeachesMainNothing(worktreeId = WORKTREE): void {
  const stored = saveWorkspaceLayout(mainLoad())
  const main = loadWorkspaceLayoutWithoutReport(
    LOCAL_EXECUTION_HOST_ID,
    stored,
    nameBasedLoadContext()
  ).layout
  expect(loadWindowSave().layout.workspaces[worktreeId]).toEqual(main.workspaces[worktreeId])
}

async function settled(): Promise<void> {
  await vi.waitFor(() => Promise.resolve())
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function terminalTab(id: string, groupId: string, worktreeId = WORKTREE): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId,
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function seed(groups: TabGroup[], layout: TabGroupLayoutNode): void {
  const terminals = groups.flatMap((group) => group.tabOrder)
  seedStore(store(), {
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })] },
    activeWorktreeId: WORKTREE,
    tabsByWorktree: {
      [WORKTREE]: terminals.map((id, index) => ({
        id,
        ptyId: null,
        worktreeId: WORKTREE,
        title: 'Terminal 1',
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 1
      }))
    },
    unifiedTabsByWorktree: {
      [WORKTREE]: groups.flatMap((group) => group.tabOrder.map((id) => terminalTab(id, group.id)))
    },
    groupsByWorktree: { [WORKTREE]: groups },
    activeGroupIdByWorktree: { [WORKTREE]: groups[0]!.id },
    layoutByWorktree: { [WORKTREE]: layout }
  })
  // Main starts from the window's last save, as it does today.
  mocks.main = loadWindowSave()
}

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.sent = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.store = createTestStore()
  seed([{ id: GROUP, worktreeId: WORKTREE, activeTabId: TERMINAL, tabOrder: [TERMINAL] }], {
    type: 'leaf',
    groupId: GROUP
  })
})

function sentTypes(): string[] {
  return mocks.sent.map((command) => command.type)
}

describe('simulator tabs in a layout-owner build', () => {
  it('starts with main holding the window’s layout', () => {
    expectSaveTeachesMainNothing()
  })

  it('records a simulator tab opened in the active group, and its close', async () => {
    const tabId = ensureSimulatorTab(WORKTREE, { placement: 'activeGroup' })
    expect(tabId).toBeTruthy()
    await settled()
    expectSaveTeachesMainNothing()

    store().getState().closeUnifiedTab(tabId!)
    await settled()
    expectSaveTeachesMainNothing()
    expect(sentTypes()).toEqual(['openSimulatorTab', 'closeTabs'])
  })

  it('records the split group a right-side open makes, and its collapse on close', async () => {
    const tabId = ensureSimulatorTab(WORKTREE, { placement: 'rightSplit' })
    await settled()
    expect(store().getState().groupsByWorktree[WORKTREE]).toHaveLength(2)
    expectSaveTeachesMainNothing()
    expect(mainLoad().layout.workspaces[WORKTREE]?.groupLayout).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: GROUP }
    })

    store().getState().closeUnifiedTab(tabId!)
    await settled()
    expect(store().getState().groupsByWorktree[WORKTREE]).toHaveLength(1)
    expectSaveTeachesMainNothing()
  })

  it('records a right-side open into the right group the workspace already has', async () => {
    const right = 'group-2'
    seed(
      [
        { id: GROUP, worktreeId: WORKTREE, activeTabId: TERMINAL, tabOrder: [TERMINAL] },
        { id: right, worktreeId: WORKTREE, activeTabId: 'terminal-2', tabOrder: ['terminal-2'] }
      ],
      {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: GROUP },
        second: { type: 'leaf', groupId: right }
      }
    )
    const tabId = ensureSimulatorTab(WORKTREE, { placement: 'rightSplit' })
    await settled()
    expect(store().getState().getTab(tabId!)?.groupId).toBe(right)
    expectSaveTeachesMainNothing()
  })

  it('records an open into the window’s emptied root group', async () => {
    seed([{ id: GROUP, worktreeId: WORKTREE, activeTabId: null, tabOrder: [] }], {
      type: 'leaf',
      groupId: GROUP
    })
    const tabId = ensureSimulatorTab(WORKTREE, { placement: 'activeGroup' })
    await settled()
    expect(mocks.sent).toMatchObject([
      { type: 'openSimulatorTab', tabId, groupId: GROUP, index: 0 }
    ])
    expectSaveTeachesMainNothing()
  })

  it('sends nothing when the workspace already has its simulator tab', async () => {
    const tabId = ensureSimulatorTab(WORKTREE)
    await settled()
    mocks.sent = []
    expect(ensureSimulatorTab(WORKTREE)).toBe(tabId)
    await settled()
    expect(mocks.sent).toEqual([])
  })

  it('leaves a paired server’s simulator tab to that server', async () => {
    const remote = 'repo2::/path/remote'
    const remoteGroup = 'group-remote'
    seedStore(
      store(),
      runtimeOwnedRepoState('env-1', 'repo2', '/path/remote', {
        worktreesByRepo: {
          repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })],
          repo2: [makeRuntimeOwnedWorktree({ id: remote, repoId: 'repo2' }, 'env-1')]
        },
        activeWorktreeId: remote,
        unifiedTabsByWorktree: { [remote]: [terminalTab('terminal-r', remoteGroup, remote)] },
        groupsByWorktree: {
          [remote]: [
            {
              id: remoteGroup,
              worktreeId: remote,
              activeTabId: 'terminal-r',
              tabOrder: ['terminal-r']
            }
          ]
        },
        activeGroupIdByWorktree: { [remote]: remoteGroup },
        layoutByWorktree: { [remote]: { type: 'leaf', groupId: remoteGroup } }
      })
    )
    const tabId = ensureSimulatorTab(remote, { placement: 'rightSplit' })
    expect(tabId).toBeTruthy()
    store().getState().closeUnifiedTab(tabId!)
    await settled()
    expect(mocks.sent).toEqual([])
  })

  it('sends nothing with the switch off', async () => {
    mocks.layoutOwnerIsMain = false
    const inGroup = ensureSimulatorTab(WORKTREE, { placement: 'activeGroup' })
    store().getState().closeUnifiedTab(inGroup!)
    const split = ensureSimulatorTab(WORKTREE, { placement: 'rightSplit' })
    store().getState().closeUnifiedTab(split!)
    await settled()
    expect(mocks.sent).toEqual([])
  })
})
