// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatPaneQueue } from './use-native-chat-pane-queue'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ tabsByWorktree: {} })
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getKnownExecutionHostIdForWorktree: () => 'local'
}))
vi.mock('./native-chat-file-link', () => ({ findTerminalTabWorktreeId: () => 'workspace' }))
vi.mock('./use-native-chat-terminal-queued-messages', () => ({
  useNativeChatTerminalQueuedMessages: () => ({
    controller: {},
    enqueue: () => Promise.resolve(false),
    pause: vi.fn()
  })
}))

it('lets an idle first prompt reach its terminal before a provider session exists', async () => {
  const session: NativeChatLiveSession = {
    sessionId: null,
    agent: 'codex',
    status: 'empty',
    messages: [],
    readPhase: 'awaiting',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: async () => 'exhausted'
  }
  const args = {
    ptyId: 'pty',
    agent: 'codex' as const,
    canSend: true,
    promptOpen: false,
    onSend: () => undefined,
    outcome: { reject: vi.fn(), holdUnconfirmed: vi.fn() },
    terminalTabId: 'tab',
    paneKey: 'pane',
    sessionId: null,
    runtimeEnvironmentId: null,
    worktreeId: 'workspace',
    composerRef: { current: null },
    stop: { clear: vi.fn(), setWorkingInterrupted: vi.fn(), interactiveSend: { cancel: vi.fn() } }
  }
  const { result, rerender } = renderHook(
    (current: NativeChatLiveSession) => useNativeChatPaneQueue(current, vi.fn(), args),
    { initialProps: session }
  )
  expect(result.current.enqueue('First prompt', [])).toBeNull()
  rerender({ ...session, status: 'working' })
  expect(await result.current.enqueue('Follow up', [])).toBe(false)
})
