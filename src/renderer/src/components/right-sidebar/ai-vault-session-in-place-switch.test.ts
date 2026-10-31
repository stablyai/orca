// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useAiVaultInPlaceAgent } from '@/lib/in-place-switch-support'
import { inPlaceSwitchCapability } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { makeTabSessionHistoryRow } from '../tab-bar/tab-session-history-test-fixture'
import { switchAiVaultSessionToCli } from './ai-vault-session-in-place-switch'

const mocks = vi.hoisted(() => ({
  capabilities: null as readonly string[] | null,
  runNativeChatCliSwitch: vi.fn(async () => {})
}))

vi.mock('@/runtime/local-runtime-capabilities', async (original) => ({
  ...(await original<object>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => mocks.capabilities,
  ensureLocalRuntimeCapabilities: async () => mocks.capabilities
}))
vi.mock('@/lib/conversation-surface-switch', () => ({
  runNativeChatCliSwitch: mocks.runNativeChatCliSwitch,
  runConversationSwitch: vi.fn()
}))

const chatRow = makeTabSessionHistoryRow({
  structuredSession: { sessionId: 'chat-1', workspaceId: 'wt-1' }
})

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  mocks.runNativeChatCliSwitch.mockClear()
})

it("labels and runs History's CLI move by the host's answer: no keeps the copy, unknown waits", () => {
  mocks.capabilities = []
  expect(renderHook(() => useAiVaultInPlaceAgent(chatRow)).result.current).toBeUndefined()
  expect(switchAiVaultSessionToCli(chatRow)).toBe(false)

  mocks.capabilities = null
  expect(renderHook(() => useAiVaultInPlaceAgent(chatRow)).result.current).toBe('claude')
  expect(switchAiVaultSessionToCli(chatRow)).toBe(false)
  expect(mocks.runNativeChatCliSwitch).not.toHaveBeenCalled()

  mocks.capabilities = [inPlaceSwitchCapability('claude')]
  expect(renderHook(() => useAiVaultInPlaceAgent(chatRow)).result.current).toBe('claude')
  expect(switchAiVaultSessionToCli(chatRow)).toBe(true)
  expect(mocks.runNativeChatCliSwitch).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'chat-1', workspaceId: 'wt-1', agent: 'claude' })
  )
})
