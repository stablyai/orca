// Layout-owner browser/chat/simulator commands draw only from main’s answers; refusals preserve tabs. With switch off, window draws without sending main.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

const mocks = vi.hoisted((): { store: unknown } => ({ store: null }))

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
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

import { ensureSimulatorTab } from '@/lib/ensure-simulator-tab'
import { openStructuredAgentSessionProvisionalTab } from '@/lib/structured-agent-session-launch-surface'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'

const WT = 'repo1::/path/wt1'
const ROOT = 'group-root'

let store: ReturnType<typeof createTestStore>
let main: TabsDrawnFromMain

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  store = createTestStore()
  mocks.store = store
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    groupsByWorktree: { [WT]: [{ id: ROOT, worktreeId: WT, activeTabId: null, tabOrder: [] }] },
    activeGroupIdByWorktree: { [WT]: ROOT },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: ROOT } },
    unifiedTabsByWorktree: { [WT]: [] }
  })
  main = await drawTabsFromMain(store)
})

afterEach(() => {
  main.close()
  resetLocalStructuredSessionVersionForTests()
})

const tabs = () => store.getState().unifiedTabsByWorktree[WT] ?? []
const tabOf = (entityId: string) => tabs().find((tab) => tab.entityId === entityId)
const mainTabs = () => layoutApplyTestTransport.mainModel?.workspaces[WT]?.tabs ?? []

function hostListing(chats: string[]): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
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

const TERMINAL = 'terminal-1'

/** The workspace with one terminal in the root group, drawn from main again. */
async function redrawWithTerminal(): Promise<void> {
  main.close()
  seedStore(store, {
    tabsByWorktree: {
      [WT]: [
        {
          id: TERMINAL,
          ptyId: null,
          worktreeId: WT,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: TERMINAL,
          entityId: TERMINAL,
          groupId: ROOT,
          worktreeId: WT,
          contentType: 'terminal',
          label: 'Terminal 1',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    groupsByWorktree: {
      [WT]: [{ id: ROOT, worktreeId: WT, activeTabId: TERMINAL, tabOrder: [TERMINAL] }]
    }
  })
  main = await drawTabsFromMain(store)
}

/** Opens with main's answer held back, then answers it; returns the opened entity id. */
async function openHeld(open: () => string): Promise<string> {
  layoutApplyTestTransport.answerWith('pending')
  const entityId = open()
  await main.settle()
  // Nothing drawn before main answers.
  expect(tabOf(entityId)).toBeUndefined()
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()
  return entityId
}

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('content tabs drawn from main’s frames', () => {
  it('shows a browser tab, its label and page only once main’s frame drew it, then selects it', async () => {
    const id = await openHeld(
      () => store.getState().createBrowserTab(WT, 'https://example.com/', { title: 'Example' }).id
    )
    const entry = tabOf(id)!
    expect(entry).toMatchObject({ contentType: 'browser', label: 'Example', groupId: ROOT })
    expect(layoutApplyTestTransport.sentOfType('openBrowserTab')[0]).toMatchObject({
      tabId: entry.id,
      browserTabId: id,
      groupId: ROOT
    })
    const pages = store.getState().browserPagesByWorkspace[id]!
    expect(pages.map((page) => page.url)).toEqual(['https://example.com/'])
    expect(store.getState().browserTabsByWorktree[WT]?.[0]).toMatchObject({
      id,
      pageIds: [pages[0]!.id],
      title: 'Example'
    })
    expect(store.getState().groupsByWorktree[WT]?.[0]?.activeTabId).toBe(entry.id)
    expect(store.getState().activeBrowserTabIdByWorktree[WT]).toBe(id)
  })

  it('closes a browser tab once main did, keeps it on the reopen list, and reopens it', async () => {
    const id = store.getState().createBrowserTab(WT, 'https://example.com/', { title: 'Ex' }).id
    await main.settle()
    layoutApplyTestTransport.answerWith('pending')
    store.getState().closeBrowserTab(id)
    await main.settle()
    expect(tabOf(id)).toBeDefined()

    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()
    expect(tabOf(id)).toBeUndefined()
    expect(store.getState().browserTabsByWorktree[WT] ?? []).toEqual([])
    expect(layoutApplyTestTransport.sentOfType('closeTabs').at(-1)).toMatchObject({
      recordClose: 'user'
    })
    expect(
      store.getState().recentlyClosedBrowserTabsByWorktree[WT]?.map((entry) => entry.workspace.id)
    ).toEqual([id])

    const reopened = store.getState().reopenClosedBrowserTab(WT)
    await main.settle()
    expect(reopened).not.toBeNull()
    expect(tabOf(reopened!.id)).toMatchObject({ label: 'Ex' })
    expect(store.getState().browserPagesByWorkspace[reopened!.id]?.[0]?.url).toBe(
      'https://example.com/'
    )
  })

  it('keeps a cleanup close off the reopen list, in main and in the window', async () => {
    const id = store.getState().createBrowserTab(WT, 'about:blank').id
    await main.settle()
    store.getState().closeBrowserTab(id, { reason: 'cleanup' })
    await main.settle()
    expect(tabOf(id)).toBeUndefined()
    expect(layoutApplyTestTransport.sentOfType('closeTabs').at(-1)).toMatchObject({
      recordClose: 'cleanup'
    })
    expect(store.getState().recentlyClosedBrowserTabsByWorktree[WT] ?? []).toEqual([])
  })

  it('adds, converts and closes a page and switches a profile only once main did', async () => {
    const id = store.getState().createBrowserTab(WT, 'https://a.test/').id
    await main.settle()
    layoutApplyTestTransport.answerWith('pending')
    const page = store.getState().createBrowserPage(id, 'https://b.test/')!
    await main.settle()
    expect(store.getState().browserPagesByWorkspace[id]).toHaveLength(1)
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()
    expect(store.getState().browserPagesByWorkspace[id]?.map((p) => p.id)).toContain(page.id)
    expect(layoutApplyTestTransport.sentOfType('openBrowserPage')).toEqual([
      expect.objectContaining({ browserTabId: id, pageId: page.id })
    ])

    store.getState().closeBrowserPage(page.id)
    await main.settle()
    expect(store.getState().browserPagesByWorkspace[id]?.map((p) => p.id)).not.toContain(page.id)

    store.getState().switchBrowserTabProfile(id, 'profile-2', 'persist:profile-2')
    await main.settle()
    expect(store.getState().browserTabsByWorktree[WT]?.[0]).toMatchObject({
      sessionProfileId: 'profile-2',
      sessionPartition: 'persist:profile-2'
    })
    expect(mainTabs().filter((tab) => tab.kind === 'browser')).toHaveLength(1)
  })

  it('opens and closes a chat tab through main, and keeps one main refused to close', async () => {
    const sessionId = await openHeld(() => {
      openStructuredAgentSessionProvisionalTab({
        worktreeId: WT,
        executionHostId: 'local',
        sessionId: 'chat-1',
        agent: 'codex'
      })
      return 'chat-1'
    })
    const chat = tabOf(sessionId)!
    expect(chat).toMatchObject({ contentType: 'agent-session', label: expect.any(String) })
    expect(chat.label).not.toBe('')
    expect(store.getState().groupsByWorktree[WT]?.[0]?.activeTabId).toBe(chat.id)

    // A deliberate freeze refuses before anything changes, so the tab stays.
    layoutApplyTestTransport.answerWith({ refuse: 'wsl_move_in_progress' })
    store.getState().closeUnifiedTab(chat.id)
    await main.settle()
    expect(tabOf(sessionId)).toBeDefined()

    layoutApplyTestTransport.answerWith('apply')
    store.getState().closeUnifiedTab(chat.id)
    await main.settle()
    expect(tabOf(sessionId)).toBeUndefined()
    expect(mainTabs().some((tab) => tab.entityId === sessionId)).toBe(false)
  })

  it('closes a window-only tab of a workspace main does not hold, as main’s tab_not_found does', async () => {
    const OTHER = 'repo1::/path/wt2'
    const tab = {
      id: 'browser-tab-1',
      entityId: 'browser-1',
      groupId: 'group-other',
      worktreeId: OTHER,
      contentType: 'browser' as const,
      label: 'Page',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    seedStore(store, {
      unifiedTabsByWorktree: { ...store.getState().unifiedTabsByWorktree, [OTHER]: [tab] },
      groupsByWorktree: {
        ...store.getState().groupsByWorktree,
        [OTHER]: [{ id: 'group-other', worktreeId: OTHER, activeTabId: tab.id, tabOrder: [tab.id] }]
      }
    })
    layoutApplyTestTransport.answerWith({ refuse: 'workspace_not_found' })

    store.getState().closeUnifiedTab(tab.id)
    await main.settle()

    expect(layoutApplyTestTransport.sentOfType('closeTabs')).toEqual([
      expect.objectContaining({ workspace: OTHER, tabIds: [tab.id] })
    ])
    expect(store.getState().unifiedTabsByWorktree[OTHER] ?? []).toEqual([])
    layoutApplyTestTransport.answerWith('apply')
  })

  it('draws a listing’s new chats in order once main places them; the listing sends nothing', async () => {
    await redrawWithTerminal()
    applyStructuredSessionTabSnapshots([hostListing(['chat-a', 'chat-b'])])
    await main.settle()
    expect(layoutApplyTestTransport.sent).toEqual([])
    expect(tabOf('chat-a')).toBeUndefined()

    // Main places listed chats in active group, in listing order.
    const commands = ['chat-a', 'chat-b'].map((sessionId) => ({
      type: 'openAgentSessionTab' as const,
      workspace: WT,
      tabId: structuredAgentSessionTabId(sessionId),
      sessionId,
      agent: 'codex' as const,
      groupId: store.getState().activeGroupIdByWorktree[WT]
    }))
    for (const command of commands) {
      await layoutApplyTestTransport.call({ command })
    }
    await main.settle()
    expect(tabs().map((tab) => tab.entityId)).toEqual([TERMINAL, 'chat-a', 'chat-b'])
    expect(store.getState().groupsByWorktree[WT]?.[0]?.tabOrder).toEqual([
      TERMINAL,
      structuredAgentSessionTabId('chat-a'),
      structuredAgentSessionTabId('chat-b')
    ])
    expect(mainTabs().map((tab) => tab.entityId)).toEqual([TERMINAL, 'chat-a', 'chat-b'])
  })

  it('opens a simulator tab to the right through main and surfaces it once drawn', async () => {
    store.getState().createBrowserTab(WT, 'about:blank')
    await main.settle()
    layoutApplyTestTransport.answerWith('pending')
    const tabId = ensureSimulatorTab(WT, { placement: 'rightSplit' })!
    // A second ask while main opens it names the same tab.
    expect(ensureSimulatorTab(WT, { placement: 'rightSplit' })).toBe(tabId)
    await main.settle()
    expect(tabs().some((tab) => tab.id === tabId)).toBe(false)

    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()
    const simulator = tabs().find((tab) => tab.id === tabId)!
    expect(simulator).toMatchObject({ contentType: 'simulator' })
    expect(simulator.groupId).not.toBe(ROOT)
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(simulator.groupId)
    expect(layoutApplyTestTransport.sentOfType('openSimulatorTab')).toHaveLength(1)

    store.getState().closeUnifiedTab(tabId)
    await main.settle()
    expect(tabs().some((tab) => tab.id === tabId)).toBe(false)
  })
})

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)('content tabs with the switch off', () => {
  it('draws browser, chat and simulator tabs at once and sends nothing', () => {
    const id = store.getState().createBrowserTab(WT, 'https://example.com/').id
    openStructuredAgentSessionProvisionalTab({
      worktreeId: WT,
      executionHostId: 'local',
      sessionId: 'chat-1',
      agent: 'codex'
    })
    const simulator = ensureSimulatorTab(WT)
    expect(tabOf(id)).toBeDefined()
    expect(tabOf('chat-1')).toBeDefined()
    expect(tabs().some((tab) => tab.id === simulator)).toBe(true)
    store.getState().closeBrowserTab(id)
    expect(tabOf(id)).toBeUndefined()
    expect(layoutApplyTestTransport.sent).toEqual([])
  })

  it('draws a listing’s new chats itself, in order, and sends nothing', async () => {
    await redrawWithTerminal()
    applyStructuredSessionTabSnapshots([hostListing(['chat-a', 'chat-b'])])
    expect(tabs().map((tab) => tab.entityId)).toEqual([TERMINAL, 'chat-a', 'chat-b'])
    expect(layoutApplyTestTransport.sent).toEqual([])
  })
})
