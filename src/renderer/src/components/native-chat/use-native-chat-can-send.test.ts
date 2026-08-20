// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = {
  paneForegroundAgentByPaneKey: {} as Record<string, { shellForeground: boolean }>
}

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({
  getDriverForPty: vi.fn(() => ({ kind: 'idle' })),
  onDriverChange: vi.fn(() => () => {})
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: (ptyId: string) => ptyId.startsWith('remote:')
}))

import { getDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { useNativeChatCanSend } from './use-native-chat-can-send'

const PANE_KEY = 'tab-1:leaf-1'

describe('useNativeChatCanSend', () => {
  beforeEach(() => {
    storeState.paneForegroundAgentByPaneKey = {}
    vi.mocked(getDriverForPty).mockReturnValue({ kind: 'idle' })
  })

  it('allows sends when nothing locks the pane', () => {
    const { result } = renderHook(() => useNativeChatCanSend('pty-1', PANE_KEY))
    expect(result.current).toEqual({ canSend: true, lockedReason: null })
  })

  it('reports mobile lock ahead of foreground evidence', () => {
    vi.mocked(getDriverForPty).mockReturnValue({ kind: 'mobile', clientId: 'phone-1' })
    storeState.paneForegroundAgentByPaneKey[PANE_KEY] = { shellForeground: true }
    const { result } = renderHook(() => useNativeChatCanSend('pty-1', PANE_KEY))
    expect(result.current).toEqual({ canSend: false, lockedReason: 'mobile' })
  })

  it("blocks sends once the local pane's foreground is proven back at the shell", () => {
    storeState.paneForegroundAgentByPaneKey[PANE_KEY] = { shellForeground: true }
    const { result } = renderHook(() => useNativeChatCanSend('pty-1', PANE_KEY))
    expect(result.current).toEqual({ canSend: false, lockedReason: 'agent-gone' })
  })

  it('does not block a remote pane on shellForeground (no producer there)', () => {
    storeState.paneForegroundAgentByPaneKey[PANE_KEY] = { shellForeground: true }
    const { result } = renderHook(() => useNativeChatCanSend('remote:pty-1', PANE_KEY))
    expect(result.current).toEqual({ canSend: true, lockedReason: null })
  })

  it('treats a null ptyId as unlocked (nothing to guard yet)', () => {
    const { result } = renderHook(() => useNativeChatCanSend(null, PANE_KEY))
    expect(result.current).toEqual({ canSend: true, lockedReason: null })
  })
})
