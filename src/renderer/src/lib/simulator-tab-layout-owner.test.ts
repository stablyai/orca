// @vitest-environment happy-dom

// With ORCA_LAYOUT_OWNER=main, a simulator tab's open and close reach main as commands first and
// the window draws them from main's frames, so its next save changes nothing in main's model.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-model'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeWorktree,
  runtimeOwnedRepoState,
  seedStore
} from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

type LayoutLoad = ReturnType<typeof loadWorkspaceLayoutWithoutReport>

type Mocks = {
  layoutOwnerIsMain: boolean
  store: ReturnType<typeof createTestStore> | null
}

const mocks = vi.hoisted((): Mocks => ({ layoutOwnerIsMain: true, store: null }))
let main: TabsDrawnFromMain

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
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

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

function sent(): readonly LayoutCommand[] {
  return layoutApplyTestTransport.sent
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
  // A lone group's tree is implied: the window may store its leaf, main none.
  const withoutLoneLeaf = (workspace: WorkspaceLayout | undefined) =>
    workspace && { ...workspace, groupLayout: split(workspace.groupLayout) }
  const split = (tree: TabGroupLayoutNode | undefined) => (tree?.type === 'split' ? tree : null)
  expect(withoutLoneLeaf(loadWindowSave().layout.workspaces[worktreeId])).toEqual(
    withoutLoneLeaf(layoutApplyTestTransport.mainModel!.workspaces[worktreeId])
  )
}

async function settled(): Promise<void> {
  await main.settle()
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
}

/** Main takes the window's layout and draws it from here on. */
async function seedDrawnFromMain(groups: TabGroup[], layout: TabGroupLayoutNode): Promise<void> {
  main?.close()
  seed(groups, layout)
  main = await drawTabsFromMain(store())
}

beforeEach(async () => {
  mocks.layoutOwnerIsMain = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.store = createTestStore()
  await seedDrawnFromMain(
    [{ id: GROUP, worktreeId: WORKTREE, activeTabId: TERMINAL, tabOrder: [TERMINAL] }],
    { type: 'leaf', groupId: GROUP }
  )
})

afterEach(() => {
  main.close()
})

function sentTypes(): string[] {
  return sent().map((command) => command.type)
}

describe('simulator tabs in a layout-owner build', () => {
  it('opens a simulator tab in the active group through main, and closes it there', async () => {
    const tabId = ensureSimulatorTab(WORKTREE, { placement: 'activeGroup' })
    expect(tabId).toBeTruthy()
    await settled()
    expectSaveTeachesMainNothing()

    store().getState().closeUnifiedTab(tabId!)
    await settled()
    expectSaveTeachesMainNothing()
    expect(sentTypes()).toEqual(['openSimulatorTab', 'closeTabs'])
  })

  it('makes the right split with the tab in main, and collapses it on close', async () => {
    const tabId = ensureSimulatorTab(WORKTREE, { placement: 'rightSplit' })
    await settled()
    expect(store().getState().groupsByWorktree[WORKTREE]).toHaveLength(2)
    expectSaveTeachesMainNothing()
    expect(layoutApplyTestTransport.mainModel!.workspaces[WORKTREE]?.groupLayout).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: GROUP }
    })

    store().getState().closeUnifiedTab(tabId!)
    await settled()
    expect(store().getState().groupsByWorktree[WORKTREE]).toHaveLength(1)
    expectSaveTeachesMainNothing()
  })

  it('opens a right-side tab into the right group the workspace already has', async () => {
    const right = 'group-2'
    await seedDrawnFromMain(
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

  it('opens into the root group of a workspace whose tabs all closed', async () => {
    await seedDrawnFromMain(
      [{ id: GROUP, worktreeId: WORKTREE, activeTabId: null, tabOrder: [] }],
      {
        type: 'leaf',
        groupId: GROUP
      }
    )
    // Main keeps no empty group, so its frame drops GROUP; the open makes the root group again.
    expect(store().getState().groupsByWorktree[WORKTREE] ?? []).toEqual([])
    const tabId = ensureSimulatorTab(WORKTREE, { placement: 'activeGroup' })
    await settled()
    const groups = store().getState().groupsByWorktree[WORKTREE] ?? []
    expect(groups).toHaveLength(1)
    expect(store().getState().getTab(tabId!)?.groupId).toBe(groups[0]!.id)
    expect(groups[0]!.tabOrder).toEqual([tabId])
    expect(sent()).toMatchObject([{ type: 'openSimulatorTab', tabId, groupId: groups[0]!.id }])
    expectSaveTeachesMainNothing()
  })

  it('sends nothing when the workspace already has its simulator tab', async () => {
    const tabId = ensureSimulatorTab(WORKTREE)
    await settled()
    const before = sent().length
    expect(ensureSimulatorTab(WORKTREE)).toBe(tabId)
    await settled()
    expect(sent()).toHaveLength(before)
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
    expect(sent()).toEqual([])
  })

  it('sends nothing with the switch off', async () => {
    mocks.layoutOwnerIsMain = false
    const inGroup = ensureSimulatorTab(WORKTREE, { placement: 'activeGroup' })
    store().getState().closeUnifiedTab(inGroup!)
    const split = ensureSimulatorTab(WORKTREE, { placement: 'rightSplit' })
    store().getState().closeUnifiedTab(split!)
    await settled()
    expect(sent()).toEqual([])
  })
})
