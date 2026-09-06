// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatProviderHandoff } from './use-native-chat-provider-handoff'
import {
  readNativeChatProviderContinuation,
  isNativeChatProviderSwitching,
  writeNativeChatProviderContinuation
} from './native-chat-provider-continuation'
import { appendPendingSendCache, clearPendingSendCacheForTests } from './native-chat-pending'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

const liveSession: NativeChatLiveSession = {
  messages: [],
  status: 'ready',
  readPhase: 'ready',
  sessionId: 'original',
  agent: 'grok',
  hasMore: false,
  loadingEarlier: false,
  loadEarlier: () => {}
}
const base = {
  liveSession,
  paneKey: 'pane-handoff',
  agent: 'grok',
  targetPtyId: 'old',
  transcriptPath: null
}
describe('native chat provider handoff input guard', () => {
  beforeEach(() => {
    writeNativeChatProviderContinuation(base.paneKey, null)
    clearPendingSendCacheForTests()
  })
  it('keeps message identity stable while a retained session is rebinding', () => {
    writeNativeChatProviderContinuation(base.paneKey, {
      agent: 'grok',
      sourcePtyId: 'older',
      targetPtyId: 'old',
      messages: [],
      context: 'history'
    })
    const { result, rerender } = renderHook(() =>
      useNativeChatProviderHandoff({
        ...base,
        liveSession: { ...liveSession, status: 'loading' }
      })
    )
    const messages = result.current.session.messages
    rerender()
    expect(result.current.session.messages).toBe(messages)
  })
  it('keeps input blocked across the async stop and prevents a second simultaneous switch', async () => {
    let resolve!: () => void
    const onSwitchProvider = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const { result } = renderHook(() => useNativeChatProviderHandoff({ ...base, onSwitchProvider }))
    let switching!: Promise<void | string>
    act(() => {
      switching = result.current.switchProvider('codex', 'model')
    })
    expect(result.current.switchingProvider).toBe(true)
    expect(isNativeChatProviderSwitching(base.paneKey)).toBe(true)
    await expect(result.current.switchProvider('claude', 'opus')).rejects.toThrow('current message')
    expect(onSwitchProvider).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve()
      await switching
    })
    expect(result.current.switchingProvider).toBe(false)
    expect(isNativeChatProviderSwitching(base.paneKey)).toBe(false)
  })
  it('leaves the existing session intact when stopping fails', async () => {
    const onSwitchProvider = vi.fn().mockRejectedValue(new Error('unverifiable'))
    const { result } = renderHook(() => useNativeChatProviderHandoff({ ...base, onSwitchProvider }))
    await act(async () => {
      await expect(result.current.switchProvider('codex', 'model')).rejects.toThrow('unverifiable')
    })
    expect(result.current.switchingProvider).toBe(false)
    expect(isNativeChatProviderSwitching(base.paneKey)).toBe(false)
    expect(readNativeChatProviderContinuation(base.paneKey)).toBeNull()
  })
  it('refuses to snapshot a conversation with an unconfirmed queued message', async () => {
    appendPendingSendCache(
      { paneKey: base.paneKey, agent: 'grok' },
      { id: 'queued', text: 'New task', sentAt: 1 }
    )
    const onSwitchProvider = vi.fn()
    const { result } = renderHook(() => useNativeChatProviderHandoff({ ...base, onSwitchProvider }))
    await expect(result.current.switchProvider('codex', 'model')).rejects.toThrow('current message')
    expect(onSwitchProvider).not.toHaveBeenCalled()
  })
})
