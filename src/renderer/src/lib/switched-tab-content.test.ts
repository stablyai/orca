// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

// The window's half of a switch, through the real store: the tab keeps its id, place, pin, color
// and selection and now holds the other content.

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: vi.fn(() => Promise.resolve())
}))

const { createTabsSliceMockApi } = await import('@/store/slices/tabs-slice-test-harness')
const api = createTabsSliceMockApi()
const { createTestStore, makeTab, makeTabGroup, makeUnifiedTab, makeWorktree, seedStore } =
  await import('@/store/slices/store-test-helpers')
const store = createTestStore()
vi.mock('@/store', () => ({ useAppStore: store }))

const { registerWindowTabContentRequests, setWindowTabContent } =
  await import('./switched-tab-content')
const { applyStructuredSessionTabSnapshots } =
  await import('@/runtime/local-structured-session-tabs-sync/snapshot-apply')
const { resetLocalStructuredSessionVersionForTests } =
  await import('@/runtime/local-structured-session-tabs-sync/inventory-generation-fence')
const { resetWebSessionTabsSnapshotFreshnessForTests } =
  await import('@/runtime/web-session-tabs-sync/tracking-lifecycle')

const WORKTREE = 'repo-1::/tmp/wt-switch'
const GROUP = 'group-1'
const SWITCHED = 'switched'

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

/** [before, switched, after] terminals; `switched` pinned and colored; `active` selected. */
function seed(active: string, live: Record<string, string[]> = {}): void {
  const terminal = (id: string, extra: object = {}) =>
    makeUnifiedTab({
      id,
      entityId: id,
      groupId: GROUP,
      worktreeId: WORKTREE,
      contentType: 'terminal',
      ...extra
    })
  seedStore(store, {
    activeWorktreeId: WORKTREE,
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE, repoId: 'repo-1', path: '/tmp/wt-switch' })]
    },
    tabsByWorktree: {
      [WORKTREE]: ['before', SWITCHED, 'after'].map((id) => makeTab({ id, worktreeId: WORKTREE }))
    },
    unifiedTabsByWorktree: {
      [WORKTREE]: [
        terminal('before', { isPinned: true }),
        terminal(SWITCHED, { isPinned: true, color: '#f00' }),
        terminal('after')
      ]
    },
    groupsByWorktree: {
      [WORKTREE]: [
        makeTabGroup({
          id: GROUP,
          worktreeId: WORKTREE,
          activeTabId: active,
          tabOrder: ['before', SWITCHED, 'after'],
          recentTabIds: [active]
        })
      ]
    },
    layoutByWorktree: { [WORKTREE]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [WORKTREE]: GROUP },
    ptyIdsByTabId: live,
    terminalLayoutsByTabId: {},
    openFiles: [],
    browserTabsByWorktree: {}
  })
}

// Each test its own conversation: a switch away from a chat retires that chat's window records.
let session = 0
const chatFrame = (
  row: Partial<Extract<RuntimeMobileSessionTabsResult['tabs'][number], { type: 'agent-session' }>>,
  sessionId = `session-${++session}`
): RuntimeMobileSessionTabsResult => ({
  worktree: WORKTREE,
  publicationEpoch: 'main',
  snapshotVersion: 1,
  activeGroupId: GROUP,
  activeTabId: null,
  activeTabType: null,
  tabs: [
    {
      type: 'agent-session',
      id: `agent-session:${sessionId}`,
      title: 'Codex',
      sessionId,
      agent: 'codex',
      isActive: false,
      ...row
    }
  ],
  tabGroups: [{ id: GROUP, activeTabId: null, tabOrder: [`agent-session:${sessionId}`] }]
})

const tabs = () => store.getState().unifiedTabsByWorktree[WORKTREE] ?? []
const group = () => store.getState().groupsByWorktree[WORKTREE]?.[0]

it.each([
  ['still held the selection', SWITCHED],
  ['lost the selection to another tab', 'after']
])(
  'a terminal tab keeps its id, place, pin, color and selection as it takes the chat, when it %s',
  (_name, active) => {
    seed(active)
    const reopen = store.getState().recentlyClosedTerminalTabsByWorktree
    expect(
      setWindowTabContent({
        worktreeId: WORKTREE,
        tabId: SWITCHED,
        expectSource: { kind: 'terminal', terminalId: SWITCHED },
        content: { kind: 'agent-session', sessionId: 'session-1', agent: 'codex' },
        focus: true
      })
    ).toEqual({ retargeted: true, tabId: SWITCHED })
    expect(tabs().find((tab) => tab.id === SWITCHED)).toMatchObject({
      contentType: 'agent-session',
      entityId: 'session-1',
      isPinned: true,
      color: '#f00',
      customLabel: null
    })
    expect(group()?.tabOrder).toEqual(['before', SWITCHED, 'after'])
    expect(group()?.activeTabId).toBe(active)
    // Its terminal's records go, as a cleanup: never a Reopen Closed Tab entry.
    expect(store.getState().tabsByWorktree[WORKTREE]?.some((tab) => tab.id === SWITCHED)).toBe(
      false
    )
    expect(store.getState().recentlyClosedTerminalTabsByWorktree).toEqual(reopen)
    // The host's frame then finds the chat in that tab: one chat tab, still in place.
    applyStructuredSessionTabSnapshots([chatFrame({ logicalTabId: SWITCHED }, 'session-1')])
    expect(
      tabs()
        .filter((tab) => tab.contentType === 'agent-session')
        .map((tab) => tab.id)
    ).toEqual([SWITCHED])
    expect(group()?.tabOrder).toEqual(['before', SWITCHED, 'after'])
  }
)

it('takes the chat from another tab that showed it: that tab goes, the chat stays open', async () => {
  seed(SWITCHED)
  const { closeStructuredAgentSession } = await import('@/runtime/structured-agent-session-close')
  store.setState({
    unifiedTabsByWorktree: {
      [WORKTREE]: [
        ...tabs(),
        makeUnifiedTab({
          id: 'open-chat',
          entityId: 'session-open',
          groupId: GROUP,
          worktreeId: WORKTREE,
          contentType: 'agent-session'
        })
      ]
    },
    groupsByWorktree: {
      [WORKTREE]: [{ ...group()!, tabOrder: ['before', SWITCHED, 'after', 'open-chat'] }]
    }
  })
  expect(
    setWindowTabContent({
      worktreeId: WORKTREE,
      tabId: SWITCHED,
      expectSource: { kind: 'terminal', terminalId: SWITCHED },
      content: { kind: 'agent-session', sessionId: 'session-open', agent: 'codex' },
      focus: false
    })
  ).toEqual({ retargeted: true, tabId: SWITCHED })
  expect(
    tabs()
      .filter((tab) => tab.entityId === 'session-open')
      .map((tab) => tab.id)
  ).toEqual([SWITCHED])
  expect(group()?.tabOrder).toEqual(['before', SWITCHED, 'after'])
  expect(closeStructuredAgentSession).not.toHaveBeenCalled()
})

it('a chat tab takes the switch’s terminal under the terminal’s own id and keeps its own', () => {
  seed(SWITCHED)
  setWindowTabContent({
    worktreeId: WORKTREE,
    tabId: SWITCHED,
    expectSource: { kind: 'terminal', terminalId: SWITCHED },
    content: { kind: 'agent-session', sessionId: 'session-round-trip', agent: 'codex' },
    focus: false
  })
  expect(
    setWindowTabContent({
      worktreeId: WORKTREE,
      tabId: SWITCHED,
      expectSource: { kind: 'agent-session', sessionId: 'session-round-trip' },
      content: { kind: 'terminal', terminalId: 'terminal-2', leafId: 'leaf-2', ptyId: 'pty-2' },
      focus: false
    })
  ).toEqual({ retargeted: true, tabId: SWITCHED })
  expect(tabs().find((tab) => tab.id === SWITCHED)).toMatchObject({
    contentType: 'terminal',
    entityId: 'terminal-2',
    isPinned: true
  })
  expect(store.getState().tabsByWorktree[WORKTREE]?.some((tab) => tab.id === 'terminal-2')).toBe(
    true
  )
  expect(
    tabs()
      .filter((tab) => tab.entityId === 'terminal-2')
      .map((tab) => tab.id)
  ).toEqual([SWITCHED])
  expect(group()?.tabOrder).toEqual(['before', SWITCHED, 'after'])
})

it('answers which tab would take the chat without changing it, and refuses a late request', () => {
  seed(SWITCHED)
  const before = tabs()
  const request = {
    worktreeId: WORKTREE,
    tabId: SWITCHED,
    expectSource: { kind: 'terminal', terminalId: SWITCHED },
    content: { kind: 'agent-session', sessionId: 'session-decide', agent: 'codex' },
    focus: true
  } as const
  expect(setWindowTabContent({ ...request, decide: true })).toEqual({
    retargeted: true,
    tabId: SWITCHED
  })
  expect(tabs()).toEqual(before)
  // Main stopped waiting at the deadline and took the request as refused: it changes nothing.
  let receive: ((request: object) => void) | undefined
  const reply = vi.fn()
  Object.assign(api, {
    ui: {
      onSetTabContent: (handler: typeof receive) => {
        receive = handler
        return () => {}
      },
      replyTabContent: reply
    }
  })
  registerWindowTabContentRequests([])
  receive!({ ...request, requestId: 'late', expiresAt: Date.now() - 1 })
  expect(reply).toHaveBeenCalledExactlyOnceWith({ requestId: 'late', retargeted: false })
  expect(tabs()).toEqual(before)
})

it('changes nothing for a tab that no longer holds just the source', () => {
  seed(SWITCHED)
  const before = tabs()
  // The user split the pane meanwhile: the tab holds more than the stopped terminal.
  store.setState({
    terminalLayoutsByTabId: {
      [SWITCHED]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-a' },
          second: { type: 'leaf', leafId: 'leaf-b' }
        },
        activeLeafId: 'leaf-a',
        expandedLeafId: null
      }
    }
  })
  expect(
    setWindowTabContent({
      worktreeId: WORKTREE,
      tabId: SWITCHED,
      expectSource: { kind: 'terminal', terminalId: SWITCHED },
      content: { kind: 'agent-session', sessionId: 'session-1', agent: 'codex' },
      focus: true
    })
  ).toEqual({ retargeted: false })
  expect(tabs()).toEqual(before)
})

it('opens a split pane’s chat right after the tab holding the source terminal', () => {
  seed(SWITCHED)
  applyStructuredSessionTabSnapshots([chatFrame({ after: { tabId: 'before' } })])
  const chat = tabs().find((tab) => tab.contentType === 'agent-session')
  expect(group()?.tabOrder).toEqual(['before', chat?.id, SWITCHED, 'after'])
})

it('changes only the decided tab: another tab holding the source is never changed instead', () => {
  seed(SWITCHED)
  const before = tabs()
  const request = {
    worktreeId: WORKTREE,
    tabId: 'before',
    expectSource: { kind: 'terminal', terminalId: SWITCHED },
    content: { kind: 'agent-session', sessionId: 'session-exact', agent: 'codex' },
    focus: false
  } as const
  // Deciding searches by content; the change, and an exact reading, stay on the named tab.
  expect(setWindowTabContent({ ...request, decide: true })).toEqual({
    retargeted: true,
    tabId: SWITCHED
  })
  expect(setWindowTabContent({ ...request, decide: true, exact: true })).toEqual({
    retargeted: false
  })
  expect(setWindowTabContent(request)).toEqual({ retargeted: false })
  expect(tabs()).toEqual(before)
})

const ipcListeners = new Map<string, Set<(...args: unknown[]) => void>>()
vi.mock('electron', () => ({
  ipcMain: {
    on: (name: string, listener: (...args: unknown[]) => void) =>
      ipcListeners.set(name, (ipcListeners.get(name) ?? new Set()).add(listener)),
    removeListener: (name: string, listener: (...args: unknown[]) => void) =>
      ipcListeners.get(name)?.delete(listener)
  }
}))

// Through main's real relay: the window applies in time and its answer is lost. That is unknown,
// never a refusal, and asking the same tab again finds the change done, without changing it twice.
it('settles a change whose answer was lost by asking the same tab again', async () => {
  seed(SWITCHED)
  vi.useFakeTimers()
  try {
    const { EventEmitter } = await import('node:events')
    const { requestTabContentFromRenderer } =
      await import('../../../main/window/tab-content-request-relay')
    const { TerminalRevealUnconfirmedError } =
      await import('../../../main/runtime/session-tabs/terminal-not-placed-error')
    let answer = false
    const webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: (_channel: string, request: Parameters<typeof setWindowTabContent>[0]) => {
        const outcome = setWindowTabContent(request)
        if (answer) {
          for (const listener of ipcListeners.get('ui:tabContentReply') ?? []) {
            listener(
              { sender: webContents },
              { ...outcome, requestId: (request as never)['requestId'] }
            )
          }
        }
      }
    })
    const mainWindow = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents })
    const request = {
      worktreeId: WORKTREE,
      tabId: SWITCHED,
      expectSource: { kind: 'terminal', terminalId: SWITCHED },
      content: { kind: 'agent-session', sessionId: 'session-lost', agent: 'codex' },
      focus: false
    } as const
    const lost = requestTabContentFromRenderer(mainWindow as never, request).catch((e) => e)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await lost).toBeInstanceOf(TerminalRevealUnconfirmedError)
    const changed = tabs()
    answer = true
    await expect(requestTabContentFromRenderer(mainWindow as never, request)).resolves.toEqual({
      retargeted: true,
      tabId: SWITCHED
    })
    expect(tabs()).toEqual(changed)
    expect(tabs().filter((tab) => tab.entityId === 'session-lost')).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
})
