// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const { resetTransport, subscriptions, transport } = vi.hoisted(() => {
  type Subscription = { onFrame: (frame: unknown) => void }
  const subscriptions: Subscription[] = []
  const transport = { readSession: vi.fn(), subscribe: vi.fn() }
  const resetTransport = (): void => {
    subscriptions.splice(0)
    transport.readSession.mockReset().mockImplementation(() => new Promise(() => {}))
    transport.subscribe.mockReset().mockImplementation((_args, onFrame) => {
      subscriptions.push({ onFrame })
      return vi.fn()
    })
  }
  return { resetTransport, subscriptions, transport }
})

vi.mock('./native-chat-session-transport', () => ({
  getNativeChatSessionTransport: () => transport
}))

import {
  useNativeChatLiveSession,
  type NativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'

const BASE_ARGS: UseNativeChatLiveSessionArgs = {
  paneKey: 'tab-1:leaf-1',
  agent: 'codex',
  sessionId: 'session-1',
  transcriptPath: '/remote/session-1.jsonl',
  runtimeEnvironmentId: 'environment-1',
  enabled: true
}
const ready = { state: 'ready', questions: [{ key: 'k', index: 0, title: 'Color?' }] }

describe('useNativeChatLiveSession async questions across re-subscribes', () => {
  let root: Root
  let latest: NativeChatLiveSession | null = null

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    latest = useNativeChatLiveSession(props)
    return null
  }

  async function render(props: UseNativeChatLiveSessionArgs): Promise<void> {
    await act(async () => {
      root.render(createElement(Probe, props))
      await Promise.resolve()
    })
  }

  async function emit(frame: unknown): Promise<void> {
    await act(async () => {
      subscriptions.at(-1)?.onFrame(frame)
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    root = createRoot(document.createElement('div'))
    latest = null
    resetTransport()
    useAppStore.setState({ agentStatusByPaneKey: {} })
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it('keeps the card up while the same transcript re-derives, and drops it on a source change', async () => {
    await render(BASE_ARGS)
    await emit({ type: 'snapshot', messages: [], hasMore: false, asyncQuestions: ready })
    expect(latest?.asyncQuestions).toEqual(ready)

    // Hidden and shown again: a new subscription to the same source starts pending.
    await render({ ...BASE_ARGS, enabled: false })
    await render(BASE_ARGS)
    expect(latest?.asyncQuestions).toEqual(ready)
    await emit({
      type: 'snapshot',
      messages: [],
      hasMore: false,
      asyncQuestions: { state: 'pending' }
    })
    expect(latest?.asyncQuestions).toEqual(ready)

    await render({ ...BASE_ARGS, sessionId: 'session-2' })
    expect(latest?.asyncQuestions).toEqual({ state: 'absent' })
  })
})
