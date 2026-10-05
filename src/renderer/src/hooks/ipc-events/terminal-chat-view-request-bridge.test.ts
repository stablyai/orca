import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_CHAT_VIEW_TAB_NOT_FOUND_ERROR,
  type TerminalChatViewRequest
} from '../../../../shared/terminal-chat-view-request'
import { useAppStore } from '../../store'
import type * as AuthorityModule from '../../store/slices/tabs/terminal-chat-pair-authority'
import { registerTerminalUiRoutingIpcBridge } from './terminal-ui-routing-ipc-bridge'
import { resetTerminalPresentationStampsForTest } from '../../store/slices/tabs/terminal-presentation-stamp'
import type {
  NativeChatTargetReadRequest,
  NativeChatTargetReadResponse
} from '../../../../shared/native-chat-target-read'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
const authority = vi.hoisted(() => {
  const state: { override: 'legacy' | null } = { override: null }
  return state
})
vi.mock('../../store/slices/tabs/terminal-chat-pair-authority', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthorityModule>()
  return {
    ...actual,
    resolveChatPairAuthority: (...args: Parameters<typeof actual.resolveChatPairAuthority>) =>
      authority.override ?? actual.resolveChatPairAuthority(...args)
  }
})
vi.mock('../../store', async () => {
  const { createTestStore } = await import('../../store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

const WT = 'repo1::/tmp/local'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

describe('renderer side of the desktop chat-view relay', () => {
  let onRequest: ((request: TerminalChatViewRequest) => void) | null
  let onTargetRead: ((request: NativeChatTargetReadRequest) => void) | null = null
  const respond = vi.fn()
  const respondTargetRead = vi.fn<(response: NativeChatTargetReadResponse) => void>()

  beforeEach(() => {
    onRequest = null
    authority.override = null
    respond.mockClear()
    respondTargetRead.mockClear()
    const subscribe = () => () => {}
    globalThis.window = {
      api: {
        // @ts-expect-error -- partial window stub: only the subscriptions this bridge registers
        ui: {
          set: vi.fn(),
          onSplitTerminal: subscribe,
          onRenameTerminal: subscribe,
          onFocusTerminal: subscribe,
          onFocusEditorTab: subscribe,
          onTerminalChatViewRequest: (callback: (request: TerminalChatViewRequest) => void) => {
            onRequest = callback
            return () => {}
          },
          respondTerminalChatView: respond,
          onNativeChatTargetRead: (callback: (request: NativeChatTargetReadRequest) => void) => {
            onTargetRead = callback
            return () => {}
          },
          respondNativeChatTargetRead: respondTargetRead
        }
      }
    }
    registerTerminalUiRoutingIpcBridge([])
  })

  it('applies the pair before replying and replies with what the store holds', () => {
    const tab = useAppStore.getState().createTab(WT, undefined, undefined, {})
    useAppStore.getState().setTabLayout(tab.id, {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: A },
        second: { type: 'leaf', leafId: B }
      },
      activeLeafId: A,
      expandedLeafId: null
    })

    onRequest!({ requestId: 'r-1', worktreeId: WT, tabId: tab.id, leafId: B, viewMode: 'chat' })

    expect(useAppStore.getState().terminalLayoutsByTabId[tab.id]?.chatLeafId).toBe(B)
    expect(respond).toHaveBeenCalledWith({
      requestId: 'r-1',
      chatView: { viewMode: 'chat', chatLeafId: B }
    })
  })

  it("uses the host's owner pick for a parent-addressed chat only when the tab has no owner (F1)", () => {
    const split = {
      root: {
        type: 'split' as const,
        direction: 'vertical' as const,
        first: { type: 'leaf' as const, leafId: A },
        second: { type: 'leaf' as const, leafId: B }
      },
      activeLeafId: B,
      expandedLeafId: null
    }
    const ownerless = useAppStore.getState().createTab(WT, undefined, undefined, {})
    useAppStore.getState().setTabLayout(ownerless.id, split)
    onRequest!({
      requestId: 'r-pick',
      worktreeId: WT,
      tabId: ownerless.id,
      leafId: null,
      viewMode: 'chat',
      ownerPickLeafId: A
    })
    expect(respond).toHaveBeenCalledWith({
      requestId: 'r-pick',
      chatView: { viewMode: 'chat', chatLeafId: A }
    })

    // An owner the desktop already holds is never moved by a host pick that raced it.
    const owned = useAppStore.getState().createTab(WT, undefined, undefined, {})
    useAppStore.getState().setTabLayout(owned.id, split)
    useAppStore.getState().applyTerminalChatPair(owned.id, B, 'chat')
    onRequest!({
      requestId: 'r-raced',
      worktreeId: WT,
      tabId: owned.id,
      leafId: null,
      viewMode: 'chat',
      ownerPickLeafId: A
    })
    expect(respond).toHaveBeenCalledWith({
      requestId: 'r-raced',
      chatView: { viewMode: 'chat', chatLeafId: B }
    })
  })

  it("refuses on its own store when the host found no agent pane, even if the host's snapshot showed an owner (R1A-2)", () => {
    // The host's published pair can lag this store: it sends its pick (null) and the store decides.
    const split = useAppStore.getState().createTab(WT, undefined, undefined, {})
    useAppStore.getState().setTabLayout(split.id, {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: A },
        second: { type: 'leaf', leafId: B }
      },
      activeLeafId: B,
      expandedLeafId: null
    })
    onRequest!({
      requestId: 'r-none',
      worktreeId: WT,
      tabId: split.id,
      leafId: null,
      viewMode: 'chat',
      ownerPickLeafId: null
    })
    const reply = respond.mock.calls.at(-1)?.[0]
    expect(reply?.requestId).toBe('r-none')
    expect(reply?.chatView?.viewMode).not.toBe('chat')
    expect(useAppStore.getState().terminalLayoutsByTabId[split.id]?.chatLeafId).toBeUndefined()

    // A single pane needs no pick: the write applies there as before.
    const single = useAppStore.getState().createTab(WT, undefined, undefined, {})
    useAppStore.getState().setTabLayout(single.id, {
      root: { type: 'leaf', leafId: A },
      activeLeafId: A,
      expandedLeafId: null
    })
    onRequest!({
      requestId: 'r-single',
      worktreeId: WT,
      tabId: single.id,
      leafId: null,
      viewMode: 'chat',
      ownerPickLeafId: null
    })
    expect(respond.mock.calls.at(-1)?.[0]?.chatView?.viewMode).toBe('chat')
  })

  const split = (bound: Record<string, string>) => ({
    root: {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: A },
      second: { type: 'leaf' as const, leafId: B }
    },
    activeLeafId: A,
    expandedLeafId: null,
    ptyIdsByLeafId: bound
  })
  const exit = (tabId: string, requestId: string, observedAtMs: number): void =>
    onRequest!({
      requestId,
      worktreeId: WT,
      tabId,
      leafId: A,
      viewMode: 'terminal',
      agentExit: { ptyId: 'pty-a', observedAtMs }
    })

  it('retires an exited agent only while its pane still owns chat and is bound to that PTY (F2)', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const owned = useAppStore.getState().createTab(WT, undefined, undefined, {})
      useAppStore.getState().setTabLayout(owned.id, split({ [A]: 'pty-a', [B]: 'pty-b' }))
      useAppStore.getState().applyTerminalChatPair(owned.id, A, 'chat')
      vi.setSystemTime(2_000)
      exit(owned.id, 'r-exit', 2_000)
      expect(respond).toHaveBeenCalledWith({
        requestId: 'r-exit',
        chatView: { viewMode: 'terminal', chatLeafId: null },
        agentExitDisposition: 'applied'
      })

      // A newer user switch moved chat to B: the stale exit of A changes nothing.
      vi.setSystemTime(3_000)
      const moved = useAppStore.getState().createTab(WT, undefined, undefined, {})
      useAppStore.getState().setTabLayout(moved.id, split({ [A]: 'pty-a', [B]: 'pty-b' }))
      useAppStore.getState().applyTerminalChatPair(moved.id, B, 'chat')
      vi.setSystemTime(4_000)
      exit(moved.id, 'r-moved', 4_000)
      expect(respond).toHaveBeenCalledWith({
        requestId: 'r-moved',
        chatView: { viewMode: 'chat', chatLeafId: B },
        agentExitDisposition: 'unchanged'
      })

      // A respawned in another PTY: the exit belongs to the old process.
      const rebound = useAppStore.getState().createTab(WT, undefined, undefined, {})
      useAppStore.getState().setTabLayout(rebound.id, split({ [A]: 'pty-a2', [B]: 'pty-b' }))
      useAppStore.getState().applyTerminalChatPair(rebound.id, A, 'chat')
      vi.setSystemTime(5_000)
      exit(rebound.id, 'r-rebound', 5_000)
      expect(respond).toHaveBeenCalledWith({
        requestId: 'r-rebound',
        chatView: { viewMode: 'chat', chatLeafId: A },
        agentExitDisposition: 'superseded'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never undoes a switch made after the exit was observed, even back to the same pane (R4.1-2)', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const tab = useAppStore.getState().createTab(WT, undefined, undefined, {})
      useAppStore.getState().setTabLayout(tab.id, split({ [A]: 'pty-a', [B]: 'pty-b' }))
      useAppStore.getState().applyTerminalChatPair(tab.id, A, 'chat')
      // The exit is seen at 2 s; the user goes terminal and back to chat(A) before it lands.
      vi.setSystemTime(3_000)
      useAppStore.getState().applyTerminalChatPair(tab.id, null, 'terminal', { intent: true })
      useAppStore.getState().applyTerminalChatPair(tab.id, A, 'chat', { intent: true })
      exit(tab.id, 'r-late', 2_000)
      expect(respond).toHaveBeenCalledWith({
        requestId: 'r-late',
        chatView: { viewMode: 'chat', chatLeafId: A },
        agentExitDisposition: 'superseded'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears a sole pane's launch hint on exit and leaves an unswitched view unset (F2)", () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const tab = useAppStore
        .getState()
        .createTab(WT, undefined, undefined, { launchAgent: 'claude' })
      useAppStore.getState().setTabLayout(tab.id, {
        root: { type: 'leaf', leafId: A },
        activeLeafId: A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [A]: 'pty-a' }
      })
      vi.setSystemTime(2_000)
      exit(tab.id, 'r-legacy', 2_000)
      const row = useAppStore.getState().tabsByWorktree[WT]?.find((t) => t.id === tab.id)
      expect(row?.launchAgent).toBeUndefined()
      expect(respond.mock.calls.at(-1)?.[0]?.chatView?.viewMode).toBeNull()
      expect(respond.mock.calls.at(-1)?.[0]?.agentExitDisposition).toBe('applied')
    } finally {
      vi.useRealTimers()
    }
  })

  it("is not superseded by the pane's automatic owner claim on mount, only by a user switch (X3-1)", () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const claimed = useAppStore.getState().createTab(WT, undefined, undefined, {})
      useAppStore.getState().setTabLayout(claimed.id, split({ [A]: 'pty-x31-a', [B]: 'pty-x31-b' }))
      useAppStore.getState().applyTerminalChatPair(claimed.id, null, 'chat', { intent: true })
      // Exit seen at 2 s; the worktree is opened at 3 s and the mounting pane claims the owner.
      vi.setSystemTime(3_000)
      useAppStore.getState().applyTerminalChatPair(claimed.id, A, 'chat')
      const retire = (tabId: string, requestId: string): void =>
        onRequest!({
          requestId,
          worktreeId: WT,
          tabId,
          leafId: A,
          viewMode: 'terminal',
          agentExit: { ptyId: 'pty-x31-a', observedAtMs: 2_000 }
        })
      retire(claimed.id, 'r-claim')
      expect(respond.mock.calls.at(-1)?.[0]?.agentExitDisposition).toBe('applied')

      vi.setSystemTime(4_000)
      const toggled = useAppStore.getState().createTab(WT, undefined, undefined, {})
      useAppStore.getState().setTabLayout(toggled.id, split({ [A]: 'pty-x31-a', [B]: 'pty-x31-b' }))
      useAppStore.getState().applyTerminalChatPair(toggled.id, A, 'chat', { intent: true })
      vi.setSystemTime(5_000)
      useAppStore.getState().applyTerminalChatPair(toggled.id, A, 'chat', { intent: true })
      onRequest!({
        requestId: 'r-toggle',
        worktreeId: WT,
        tabId: toggled.id,
        leafId: A,
        viewMode: 'terminal',
        agentExit: { ptyId: 'pty-x31-a', observedAtMs: 4_500 }
      })
      expect(respond.mock.calls.at(-1)?.[0]?.agentExitDisposition).toBe('superseded')
    } finally {
      vi.useRealTimers()
    }
  })

  it("is not superseded by the exit's own hint clear (R2-1)", () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const tab = useAppStore
        .getState()
        .createTab(WT, undefined, undefined, { launchAgent: 'claude' })
      useAppStore.getState().setTabLayout(tab.id, {
        root: { type: 'leaf', leafId: A },
        activeLeafId: A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [A]: 'pty-a' }
      })
      useAppStore.getState().applyTerminalChatPair(tab.id, A, 'chat')
      // Seen at 5 s; the tab bar's useTabAgent clears the hint from the same evidence first.
      vi.setSystemTime(5_020)
      useAppStore.getState().clearTabLaunchAgent(tab.id)
      vi.setSystemTime(5_080)
      exit(tab.id, 'r-own-hint', 5_000)
      expect(respond.mock.calls.at(-1)?.[0]).toMatchObject({
        requestId: 'r-own-hint',
        chatView: { viewMode: 'terminal' },
        agentExitDisposition: 'applied'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies a retry after a renderer reload hydrated the tab again (R2-2)', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const tab = useAppStore.getState().createTab(WT, undefined, undefined, {})
      useAppStore.getState().setTabLayout(tab.id, split({ [A]: 'pty-a', [B]: 'pty-b' }))
      useAppStore.getState().applyTerminalChatPair(tab.id, A, 'chat')
      // Exit seen at 2 s; the reload at 3 s starts with no intents and hydrates the same rows.
      vi.setSystemTime(3_000)
      resetTerminalPresentationStampsForTest()
      useAppStore.setState((state) => ({
        tabsByWorktree: { ...state.tabsByWorktree, [WT]: [...(state.tabsByWorktree[WT] ?? [])] },
        terminalLayoutsByTabId: { ...state.terminalLayoutsByTabId }
      }))
      vi.setSystemTime(3_500)
      exit(tab.id, 'r-reload', 2_000)
      expect(respond.mock.calls.at(-1)?.[0]?.agentExitDisposition).toBe('applied')
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a pane's token and its exit through a sibling's rebind or split (R2-9)", () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const tab = useAppStore.getState().createTab(WT, undefined, undefined, {})
      useAppStore.getState().setTabLayout(tab.id, split({ [A]: 'pty-r29-a', [B]: 'pty-b' }))
      useAppStore.getState().applyTerminalChatPair(tab.id, A, 'chat')
      const tokenOfA = (): string | undefined => {
        onTargetRead!({ requestId: 'read-a', ptyId: 'pty-r29-a' })
        const read = respondTargetRead.mock.calls.at(-1)?.[0]?.read
        return read?.kind === 'chat-target' ? read.presentationToken : undefined
      }
      const admitted = tokenOfA()
      expect(admitted).toBeDefined()
      // Exit of A seen at 2 s; sibling B respawns, then B is split, before the retirement lands.
      vi.setSystemTime(2_500)
      useAppStore.getState().setTabLayout(tab.id, split({ [A]: 'pty-r29-a', [B]: 'pty-b2' }))
      expect(tokenOfA()).toBe(admitted)
      useAppStore.getState().setTabLayout(tab.id, {
        ...split({ [A]: 'pty-r29-a', [B]: 'pty-b2' }),
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: A },
          second: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: B },
            second: { type: 'leaf', leafId: C }
          }
        }
      })
      expect(tokenOfA()).toBe(admitted)
      onRequest!({
        requestId: 'r-sibling',
        worktreeId: WT,
        tabId: tab.id,
        leafId: A,
        viewMode: 'terminal',
        agentExit: { ptyId: 'pty-r29-a', observedAtMs: 2_000 }
      })
      expect(respond.mock.calls.at(-1)?.[0]?.agentExitDisposition).toBe('applied')
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a composer target read from committed state only', () => {
    const chat = useAppStore.getState().createTab(WT, undefined, undefined, {})
    useAppStore.getState().setTabLayout(chat.id, split({ [A]: 'pty-read-a', [B]: 'pty-read-b' }))
    useAppStore.getState().applyTerminalChatPair(chat.id, A, 'chat')
    const legacy = useAppStore
      .getState()
      .createTab(WT, undefined, undefined, { launchAgent: 'codex' })
    useAppStore.getState().setTabLayout(legacy.id, {
      root: { type: 'leaf', leafId: A },
      activeLeafId: A,
      expandedLeafId: null,
      ptyIdsByLeafId: { [A]: 'pty-legacy' }
    })
    const read = (ptyId: string): void => onTargetRead!({ requestId: ptyId, ptyId })

    read('pty-read-a')
    read('pty-read-b')
    read('pty-legacy')
    read('pty-missing')
    useAppStore.getState().clearTabLaunchAgent(legacy.id)
    read('pty-legacy')

    const kinds = respondTargetRead.mock.calls.map(([response]) => [
      response.requestId,
      response.read?.kind
    ])
    expect(kinds).toEqual([
      ['pty-read-a', 'chat-target'],
      ['pty-read-b', 'not-chat-target'],
      ['pty-legacy', 'chat-target'],
      ['pty-missing', 'unknown-target'],
      ['pty-legacy', 'not-chat-target']
    ])
  })

  it('reports an unknown tab', () => {
    onRequest!({
      requestId: 'r-2',
      worktreeId: WT,
      tabId: 'missing',
      leafId: null,
      viewMode: 'chat'
    })
    expect(respond).toHaveBeenCalledWith({
      requestId: 'r-2',
      error: TERMINAL_CHAT_VIEW_TAB_NOT_FOUND_ERROR
    })
  })

  it('refuses a worktree another host owns without touching the mirrored tab', () => {
    const tab = useAppStore.getState().createTab(WT, undefined, undefined, {})
    authority.override = 'legacy'

    onRequest!({ requestId: 'r-3', worktreeId: WT, tabId: tab.id, leafId: null, viewMode: 'chat' })

    expect(respond).toHaveBeenCalledWith({
      requestId: 'r-3',
      error: TERMINAL_CHAT_VIEW_TAB_NOT_FOUND_ERROR
    })
    expect(
      useAppStore.getState().unifiedTabsByWorktree[WT]?.find((t) => t.entityId === tab.id)?.viewMode
    ).not.toBe('chat')
  })
})
