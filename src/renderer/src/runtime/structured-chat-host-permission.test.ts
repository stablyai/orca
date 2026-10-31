// @vitest-environment happy-dom
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const contactListeners: (() => void)[] = []
  const settings: Partial<GlobalSettings> = { nativeChatPermissionMode: 'ask' }
  return { supportsCapability: vi.fn(), callRuntimeRpc: vi.fn(), contactListeners, settings }
})

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability,
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/store', () => {
  const state = { settings: mocks.settings }
  const useAppStore = (select: (s: typeof state) => unknown) => select(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('./runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (_id: string, listener: () => void) => {
    mocks.contactListeners.push(listener)
    return () => undefined
  }
}))

import {
  readStructuredChatHostPermissionVerdict,
  useStructuredChatHostPermissionVerdict
} from './structured-chat-host-permission'

const PAIRED = { kind: 'environment', environmentId: 'server-1' } as const

beforeEach(() => {
  vi.clearAllMocks()
  mocks.supportsCapability.mockResolvedValue(false)
  mocks.settings.nativeChatPermissionMode = 'ask'
  mocks.settings.agentPermissionDefault = undefined
  mocks.settings.agentPermissionOverrides = {}
})

describe('the permission verdict on a paired host', () => {
  // STA-10671: 1.4.224 started Claude with --dangerously-skip-permissions while Settings read Ask.
  it('refuses Ask on an older host whose Agent Permissions bypass approval', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ settings: { agentDefaultArgs: {} } })

    await expect(readStructuredChatHostPermissionVerdict(PAIRED, 'claude', 'ask')).resolves.toEqual(
      { kind: 'refused', hostMode: 'full-access' }
    )
    await expect(
      readStructuredChatHostPermissionVerdict(PAIRED, 'codex', 'accept-edits')
    ).resolves.toEqual({ kind: 'refused', hostMode: 'full-access' })
  })

  it('checks the scoped agent choice instead of a permissive global fallback', async () => {
    mocks.settings.nativeChatPermissionMode = 'full-access'
    mocks.settings.agentPermissionDefault = 'full-access'
    mocks.settings.agentPermissionOverrides = { codex: 'auto' }
    mocks.callRuntimeRpc.mockResolvedValue({ settings: { agentDefaultArgs: {} } })
    await expect(readStructuredChatHostPermissionVerdict(PAIRED, 'codex')).resolves.toEqual({
      kind: 'refused',
      hostMode: 'full-access'
    })
    await expect(readStructuredChatHostPermissionVerdict(PAIRED, 'claude')).resolves.toEqual({
      kind: 'allowed'
    })
  })

  it('delegates Own to the old host without relaxing explicit or unknown requests', async () => {
    mocks.settings.agentPermissionDefault = 'own'
    mocks.callRuntimeRpc.mockResolvedValue({ settings: { agentDefaultArgs: {} } })
    mocks.settings.nativeChatPermissionMode = 'full-access'
    await expect(readStructuredChatHostPermissionVerdict(PAIRED, 'codex')).resolves.toEqual({
      kind: 'allowed'
    })
    await expect(readStructuredChatHostPermissionVerdict(PAIRED, 'codex', 'own')).resolves.toEqual({
      kind: 'allowed'
    })
    await expect(
      readStructuredChatHostPermissionVerdict(PAIRED, 'codex', 'future-mode')
    ).resolves.toEqual({ kind: 'refused', hostMode: 'full-access' })
    mocks.settings.nativeChatPermissionMode = 'ask'
    await expect(readStructuredChatHostPermissionVerdict(PAIRED, 'codex')).resolves.toEqual({
      kind: 'allowed'
    })
    mocks.callRuntimeRpc.mockResolvedValue({ settings: { agentDefaultArgs: { codex: '' } } })
    await expect(readStructuredChatHostPermissionVerdict(PAIRED, 'codex')).resolves.toEqual({
      kind: 'allowed'
    })
  })

  it('is unverified, never allowed, when the host cannot say', async () => {
    mocks.supportsCapability.mockRejectedValue(new Error('timeout'))
    mocks.callRuntimeRpc.mockRejectedValue(new Error('timeout'))

    for (const requested of ['ask', 'own']) {
      await expect(
        readStructuredChatHostPermissionVerdict(PAIRED, 'claude', requested)
      ).resolves.toEqual({ kind: 'unverified' })
    }
  })
})

describe('the permission verdict a chat holds', () => {
  it('checks again, holding the chat, when contact with the host returns', async () => {
    mocks.contactListeners.length = 0
    mocks.supportsCapability.mockResolvedValue(true)
    const { result } = renderHook(() => useStructuredChatHostPermissionVerdict(PAIRED, 'claude'))
    expect(result.current).toMatchObject({ kind: 'checking' })
    await vi.waitFor(() => expect(result.current).toMatchObject({ kind: 'allowed' }))

    // The host came back as an older build: its answer is still on the way.
    mocks.supportsCapability.mockReturnValue(new Promise(() => undefined))
    act(() => mocks.contactListeners.forEach((listener) => listener()))
    expect(result.current).toMatchObject({ kind: 'checking' })
  })
})

describe('a held chat', () => {
  it('asks again while held, so a host switched to Manual lets it through', async () => {
    vi.useFakeTimers()
    try {
      mocks.callRuntimeRpc.mockResolvedValue({ settings: { agentDefaultArgs: {} } })
      const { result } = renderHook(() => useStructuredChatHostPermissionVerdict(PAIRED, 'claude'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(result.current.kind).toBe('refused')

      mocks.callRuntimeRpc.mockResolvedValue({ settings: { agentDefaultArgs: { claude: '' } } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(result.current).toMatchObject({ kind: 'allowed' })
    } finally {
      vi.useRealTimers()
    }
  })
})
