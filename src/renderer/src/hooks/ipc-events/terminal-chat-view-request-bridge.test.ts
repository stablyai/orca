import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_CHAT_VIEW_TAB_NOT_FOUND_ERROR,
  type TerminalChatViewRequest
} from '../../../../shared/terminal-chat-view-request'
import { useAppStore } from '../../store'
import type * as AuthorityModule from '../../store/slices/tabs/terminal-chat-pair-authority'
import { registerTerminalUiRoutingIpcBridge } from './terminal-ui-routing-ipc-bridge'

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

describe('renderer side of the desktop chat-view relay', () => {
  let onRequest: ((request: TerminalChatViewRequest) => void) | null
  const respond = vi.fn()

  beforeEach(() => {
    onRequest = null
    authority.override = null
    respond.mockClear()
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
          respondTerminalChatView: respond
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
