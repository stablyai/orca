// @vitest-environment happy-dom

// With ORCA_LAYOUT_OWNER=main, a chat tab's open and close reach main as commands, so the window's
// next save changes nothing in main's model (what the save-divergence detector checks).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
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
vi.mock('./runtime-rpc-client', () => ({
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

import { openStructuredAgentSessionProvisionalTab } from '@/lib/structured-agent-session-provisional-tab'
import { applyStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import { recordSyncedAgentSessionTabsInLayoutOwner } from './agent-session-tab-layout-owner'

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

function windowSave(): WorkspaceSessionState {
  return buildWorkspaceSessionPayload(store().getState())
}

/** What main's next read of its stored copy holds, as the detector reads it before a save. */
function mainStoredModel() {
  const stored = saveWorkspaceLayout(mainLoad())
  return loadWorkspaceLayoutWithoutReport(LOCAL_EXECUTION_HOST_ID, stored, nameBasedLoadContext())
    .layout
}

/** The workspace as the window's save would give it to main, beside main's own copy. */
function windowAndMain() {
  const window = loadWorkspaceLayoutWithoutReport(
    LOCAL_EXECUTION_HOST_ID,
    windowSave(),
    nameBasedLoadContext()
  ).layout
  const main = mainStoredModel()
  return { window: window.workspaces[WORKTREE], main: main.workspaces[WORKTREE] }
}

function expectSaveTeachesMainNothing(): void {
  const { window, main } = windowAndMain()
  expect(window).toEqual(main)
}

async function settled(): Promise<void> {
  await vi.waitFor(() => Promise.resolve())
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function hostListing(version: number, chats: string[]): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: chats.map((sessionId) => ({
      type: 'agent-session' as const,
      id: `agent-session:${sessionId}`,
      title: 'Codex Chat',
      sessionId,
      agent: 'codex' as const,
      isActive: false
    }))
  }
}

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.sent = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const testStore = createTestStore()
  mocks.store = testStore
  const terminal: Tab = {
    id: TERMINAL,
    entityId: TERMINAL,
    groupId: GROUP,
    worktreeId: WORKTREE,
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const group: TabGroup = {
    id: GROUP,
    worktreeId: WORKTREE,
    activeTabId: TERMINAL,
    tabOrder: [TERMINAL]
  }
  seedStore(testStore, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })] },
    activeWorktreeId: WORKTREE,
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: TERMINAL,
          ptyId: null,
          worktreeId: WORKTREE,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabsByWorktree: { [WORKTREE]: [terminal] },
    groupsByWorktree: { [WORKTREE]: [group] },
    activeGroupIdByWorktree: { [WORKTREE]: GROUP },
    layoutByWorktree: { [WORKTREE]: { type: 'leaf', groupId: GROUP } }
  })
  // Main starts from the window's last save, as it does today.
  mocks.main = loadWorkspaceLayoutWithoutReport(
    LOCAL_EXECUTION_HOST_ID,
    windowSave(),
    nameBasedLoadContext()
  )
})

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
})

describe('chat tabs in a layout-owner build', () => {
  it('starts with main holding the window’s layout', () => {
    expectSaveTeachesMainNothing()
  })

  it('records a chat the window opens and closes, so its saves teach main nothing', async () => {
    const tab = openStructuredAgentSessionProvisionalTab({
      worktreeId: WORKTREE,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      sessionId: 'chat-1',
      agent: 'codex'
    })
    await settled()
    expectSaveTeachesMainNothing()

    store().getState().closeUnifiedTab(tab.id)
    await settled()
    expectSaveTeachesMainNothing()
    expect(mocks.sent.map((command) => command.type)).toEqual(['openAgentSessionTab', 'closeTabs'])
  })

  it('records the chats a host listing adds to and removes from the tab bar', async () => {
    applyStructuredSessionTabSnapshots([hostListing(1, ['chat-2'])])
    await settled()
    expect(
      store()
        .getState()
        .unifiedTabsByWorktree[WORKTREE]?.map((tab) => tab.entityId)
    ).toEqual([TERMINAL, 'chat-2'])
    expectSaveTeachesMainNothing()

    applyStructuredSessionTabSnapshots([hostListing(2, [])])
    await settled()
    expect(
      store()
        .getState()
        .unifiedTabsByWorktree[WORKTREE]?.map((tab) => tab.entityId)
    ).toEqual([TERMINAL])
    expectSaveTeachesMainNothing()
  })

  it('sends a listing’s new chats in tab order, so each anchor is already in main', async () => {
    const before = store().getState()
    const chat = (sessionId: string): Tab => ({
      id: `structured-agent-session-${sessionId}`,
      entityId: sessionId,
      groupId: GROUP,
      worktreeId: WORKTREE,
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 5
    })
    const [a, b] = [chat('chat-a'), chat('chat-b')]
    const after = {
      ...before,
      // The tab bar lists b first; the group shows a first.
      unifiedTabsByWorktree: { [WORKTREE]: [...before.unifiedTabsByWorktree[WORKTREE]!, b, a] },
      groupsByWorktree: {
        [WORKTREE]: [
          { ...before.groupsByWorktree[WORKTREE]![0]!, tabOrder: [TERMINAL, a.id, b.id] }
        ]
      }
    }
    recordSyncedAgentSessionTabsInLayoutOwner(before, after, [WORKTREE])
    await settled()
    expect(
      mocks.sent.flatMap((command) =>
        command.type === 'openAgentSessionTab' ? [[command.tabId, command.afterTabId]] : []
      )
    ).toEqual([
      [a.id, TERMINAL],
      [b.id, a.id]
    ])
    expect(mainLoad().layout.workspaces[WORKTREE]?.groups[0]?.tabOrder).toEqual([
      TERMINAL,
      a.id,
      b.id
    ])
  })

  it('leaves a paired server’s chat tabs to that server', async () => {
    const remote = 'repo2::/path/remote'
    seedStore(
      store(),
      runtimeOwnedRepoState('env-1', 'repo2', '/path/remote', {
        worktreesByRepo: {
          repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })],
          repo2: [makeRuntimeOwnedWorktree({ id: remote, repoId: 'repo2' }, 'env-1')]
        }
      })
    )
    const tab = openStructuredAgentSessionProvisionalTab({
      worktreeId: remote,
      executionHostId: 'runtime:env-1',
      sessionId: 'chat-5',
      agent: 'codex'
    })
    expect(
      store()
        .getState()
        .unifiedTabsByWorktree[remote]?.map((entry) => entry.id)
    ).toEqual([tab.id])
    store().getState().closeUnifiedTab(tab.id)
    await settled()
    expect(store().getState().unifiedTabsByWorktree[remote]).toEqual([])
    expect(mocks.sent).toEqual([])
  })

  it('sends nothing with the switch off', async () => {
    mocks.layoutOwnerIsMain = false
    const tab = openStructuredAgentSessionProvisionalTab({
      worktreeId: WORKTREE,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      sessionId: 'chat-3',
      agent: 'codex'
    })
    applyStructuredSessionTabSnapshots([hostListing(1, ['chat-3', 'chat-4'])])
    store().getState().closeUnifiedTab(tab.id)
    await settled()
    expect(mocks.sent).toEqual([])
  })
})
