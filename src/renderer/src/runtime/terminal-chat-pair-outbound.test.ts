// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { CHAT_PAIR_PENDING_CONFIRM_MS } from '../../../shared/chat-pair-pending'
import { selectUnifiedTerminalTabFields } from '@/components/terminal-pane/terminal-unified-tab-lookup'
import {
  selectPendingChatPair,
  selectPendingChatPairsForWorktree
} from '@/store/slices/tabs/terminal-chat-pair-effective'
import {
  A,
  B,
  TERMINAL_TAB_ID,
  WT,
  applyHostSnapshot,
  effectivePair,
  installFakeHost,
  makeHostPairSnapshot,
  resetPairedStore
} from './terminal-chat-pair-host-test-rig'

async function settle(): Promise<void> {
  await vi.dynamicImportSettled()
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

function click(leafId: string | null, mode: 'terminal' | 'chat'): void {
  useAppStore.getState().applyTerminalChatPair(TERMINAL_TAB_ID, leafId, mode, { userToggle: true })
}

function paneSaysChat(): boolean {
  const state = useAppStore.getState()
  return selectUnifiedTerminalTabFields(
    state.unifiedTabsByWorktree,
    WT,
    TERMINAL_TAB_ID,
    selectPendingChatPair(state, WT, TERMINAL_TAB_ID)
  ).isChatViewMode
}

function tabBarSaysChat(): boolean {
  const state = useAppStore.getState()
  const pending = selectPendingChatPairsForWorktree(state, WT)[TERMINAL_TAB_ID]
  const unified = state.unifiedTabsByWorktree[WT]?.find((tab) => tab.entityId === TERMINAL_TAB_ID)
  return (pending ?? unified)?.viewMode === 'chat'
}

const CHAT_A_REPLY = {
  updated: true as const,
  chatView: { viewMode: 'chat' as const, chatLeafId: A }
}

describe('paired desktop chat-pair writes on a host-owned worktree', () => {
  let host: ReturnType<typeof installFakeHost>
  let warn: ReturnType<typeof vi.spyOn>
  let toastError: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    resetPairedStore()
    host = installFakeHost()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    toastError = vi.spyOn(toast, 'error').mockImplementation(() => 0)
    applyHostSnapshot(makeHostPairSnapshot({ viewMode: 'terminal' }))
  })
  afterEach(() => {
    warn.mockRestore()
    toastError.mockRestore()
    vi.useRealTimers()
  })

  it('shows the click at once and sends one fenced leaf write without touching host truth', async () => {
    const before = useAppStore.getState()
    click(A, 'chat')
    expect(effectivePair()).toEqual({ viewMode: 'chat', chatLeafId: A })
    expect(paneSaysChat()).toBe(true)
    expect(tabBarSaysChat()).toBe(true)
    const after = useAppStore.getState()
    expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
    expect(after.unifiedTabsByWorktree).toBe(before.unifiedTabsByWorktree)
    expect(after.terminalLayoutsByTabId).toBe(before.terminalLayoutsByTabId)
    await settle()
    expect(host.pairWrites().map((write) => write.params)).toEqual([
      {
        worktree: expect.any(String),
        tabId: `host-tab-1::${A}`,
        viewMode: 'chat',
        chatViewWrite: { writerId: expect.any(String), seq: 1 }
      }
    ])
  })

  it('retires the overlay when a snapshot that already shows the pair precedes the reply', async () => {
    click(A, 'chat')
    await settle()
    applyHostSnapshot(makeHostPairSnapshot({ viewMode: 'chat', owner: A }))
    host.pairWrites()[0]!.resolve(CHAT_A_REPLY)
    await settle()
    expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
    expect(effectivePair()).toEqual({ viewMode: 'chat', chatLeafId: A })
    expect(host.calls).toHaveLength(1)
  })

  it('returns pane and tab bar to the host pair on a rejection, with no store write or echo', async () => {
    click(A, 'chat')
    await settle()
    const before = useAppStore.getState()
    host.pairWrites()[0]!.reject('tab_not_found')
    await settle()
    const after = useAppStore.getState()
    expect(after.pendingChatPairByTabId).toEqual({})
    expect(paneSaysChat()).toBe(false)
    expect(tabBarSaysChat()).toBe(false)
    expect(effectivePair()).toEqual({ viewMode: 'terminal' })
    expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
    expect(after.unifiedTabsByWorktree).toBe(before.unifiedTabsByWorktree)
    expect(after.terminalLayoutsByTabId).toBe(before.terminalLayoutsByTabId)
    expect(after.activeTabId).toBe(before.activeTabId)
    expect(host.calls).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls).toEqual([["Couldn't switch view"]])
  })

  it('expires an adopted reply the host never publishes', async () => {
    click(A, 'chat')
    await settle()
    host.pairWrites()[0]!.resolve(CHAT_A_REPLY)
    await settle()
    expect(paneSaysChat()).toBe(true)
    await vi.advanceTimersByTimeAsync(CHAT_PAIR_PENDING_CONFIRM_MS - 1)
    expect(paneSaysChat()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(paneSaysChat()).toBe(false)
    expect(tabBarSaysChat()).toBe(false)
    expect(host.calls).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('does not let an older write expiry clear a newer click', async () => {
    click(A, 'chat')
    await settle()
    host.pairWrites()[0]!.resolve(CHAT_A_REPLY)
    await settle()
    await vi.advanceTimersByTimeAsync(CHAT_PAIR_PENDING_CONFIRM_MS - 1000)
    click(B, 'chat')
    await vi.advanceTimersByTimeAsync(CHAT_PAIR_PENDING_CONFIRM_MS * 2)
    expect(effectivePair()).toEqual({ viewMode: 'chat', chatLeafId: B })
  })

  it('drops pending clicks without a warning when the host loses the marker', async () => {
    click(A, 'chat')
    await settle()
    applyHostSnapshot(makeHostPairSnapshot({ marker: false, viewMode: 'terminal' }))
    expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
    host.pairWrites()[0]!.resolve(CHAT_A_REPLY)
    await settle()
    expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
    expect(warn).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('drops a pending claim whose leaf left the host tree', async () => {
    click(B, 'chat')
    await settle()
    applyHostSnapshot(makeHostPairSnapshot({ viewMode: 'terminal', leaves: [A] }))
    expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
    host.pairWrites()[0]!.resolve(CHAT_A_REPLY)
    await settle()
    expect(toastError).not.toHaveBeenCalled()
  })

  describe('delivery-unknown failures', () => {
    it('resends once with the same writer and seq, and a duplicate reply retires quietly', async () => {
      click(A, 'chat')
      await settle()
      host.pairWrites()[0]!.reject('runtime_timeout')
      await settle()
      expect(host.pairWrites()).toHaveLength(2)
      expect(host.pairWrites()[1]!.params).toEqual(host.pairWrites()[0]!.params)
      applyHostSnapshot(makeHostPairSnapshot({ viewMode: 'chat', owner: A }))
      host.pairWrites()[1]!.resolve(CHAT_A_REPLY)
      await settle()
      expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
      expect(warn).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    })

    it('warns once and returns to the host pair when the resend also fails', async () => {
      click(A, 'chat')
      await settle()
      host.pairWrites()[0]!.reject('runtime_timeout')
      await settle()
      host.pairWrites()[1]!.reject('chat_view_relay_timeout')
      await settle()
      expect(host.pairWrites()).toHaveLength(2)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(toastError.mock.calls).toEqual([["Couldn't confirm the view switch"]])
      expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
      expect(paneSaysChat()).toBe(false)
    })

    it('never resends an older write once a newer click was sent', async () => {
      click(A, 'chat')
      click(null, 'terminal')
      await settle()
      host.pairWrites()[0]!.reject('runtime_timeout')
      await settle()
      expect(host.pairWrites().map((write) => write.params.chatViewWrite)).toEqual([
        { writerId: expect.any(String), seq: 1 },
        { writerId: expect.any(String), seq: 2 }
      ])
      expect(toastError).not.toHaveBeenCalled()
    })
  })
})
