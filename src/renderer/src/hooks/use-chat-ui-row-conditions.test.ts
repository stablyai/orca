// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const mocks = vi.hoisted(
  (): { nativeChat: boolean; heldChanged: ((held: boolean) => void) | null } => ({
    nativeChat: false,
    heldChanged: null
  })
)

vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: { experimentalNativeChat: boolean } }) => unknown) =>
    selector({ settings: { experimentalNativeChat: mocks.nativeChat } })
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  restoreLocalStructuredSessionTabsOnce: vi.fn(async () => undefined)
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { resetLocalStructuredChatsForTests } from '@/runtime/local-structured-chats'
import { useChatUiRowConditions } from './use-chat-ui-row-conditions'

function stubRuntime(getStatus: () => Promise<{ capabilities?: string[] }>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        holdsStructuredAgentSessions: async () => false,
        onStructuredAgentSessionsHeldChanged: (listener: (held: boolean) => void) => {
          mocks.heldChanged = listener
          return () => {
            mocks.heldChanged = null
          }
        }
      },
      runtime: { getStatus }
    }
  })
}

beforeEach(() => {
  mocks.nativeChat = false
  mocks.heldChanged = null
  resetLocalStructuredChatsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
})

afterEach(() => {
  resetLocalStructuredChatsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  Reflect.deleteProperty(window, 'api')
})

describe('the live Chat UI row conditions', () => {
  it('leaves Queue follow-ups out until this machine says it queues follow-ups', async () => {
    let answer: (status: { capabilities: string[] }) => void = () => {}
    stubRuntime(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    mocks.nativeChat = true
    const { result } = renderHook(() => useChatUiRowConditions())
    expect(result.current).toEqual({ structuredChatsInUse: true, hostQueuesChatMessages: false })

    await act(async () => {
      answer({ capabilities: [AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY] })
    })
    await waitFor(() => expect(result.current.hostQueuesChatMessages).toBe(true))
  })

  it('keeps Queue follow-ups out when this machine does not queue follow-ups', async () => {
    const getStatus = vi.fn(async () => ({ capabilities: [] }))
    stubRuntime(getStatus)
    const { result } = renderHook(() => useChatUiRowConditions())
    await waitFor(() => expect(getStatus).toHaveBeenCalled())
    expect(result.current.hostQueuesChatMessages).toBe(false)
  })

  it('counts chats in use with Chat UI off only while this machine holds some', async () => {
    stubRuntime(async () => ({ capabilities: [] }))
    const { result } = renderHook(() => useChatUiRowConditions())
    expect(result.current.structuredChatsInUse).toBe(false)

    await waitFor(() => expect(mocks.heldChanged).not.toBeNull())
    act(() => mocks.heldChanged?.(true))
    expect(result.current.structuredChatsInUse).toBe(true)
  })
})
