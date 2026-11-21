import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { useAppStore } from '@/store'

const { resetTransport, subscriptions, transport } = vi.hoisted(() => {
  type Subscription = {
    onFrame: (frame: unknown) => void
    unsubscribe: ReturnType<typeof vi.fn>
  }
  const subscriptions: Subscription[] = []
  const transport = {
    readSession: vi.fn(),
    subscribe: vi.fn()
  }
  const resetTransport = (): void => {
    subscriptions.splice(0)
    transport.readSession.mockReset().mockImplementation(() => new Promise(() => {}))
    transport.subscribe.mockReset().mockImplementation((_args, onFrame) => {
      const subscription = { onFrame, unsubscribe: vi.fn() }
      subscriptions.push(subscription)
      return subscription.unsubscribe
    })
  }
  return { resetTransport, subscriptions, transport }
})

vi.mock('./native-chat-session-transport', () => ({
  getNativeChatSessionTransport: () => transport
}))

import type {
  NativeChatLiveSession,
  UseNativeChatLiveSessionArgs
} from './native-chat-live-session-contract'

import { useNativeChatRetainedSession } from './use-native-chat-retained-session'

const BASE_ARGS: UseNativeChatLiveSessionArgs = {
  paneKey: 'tab-1:leaf-1',
  agent: 'claude',
  sessionId: 'session-1',
  transcriptPath: '/remote/session-1.jsonl',
  runtimeEnvironmentId: 'environment-1',
  enabled: true
}

function assistant(id: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp,
    source: 'transcript'
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve = (_value: T): void => {}
  let reject = (_reason: unknown): void => {}
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

describe('useNativeChatLiveSession visibility', () => {
  let root: Root
  let latest: NativeChatLiveSession | null = null
  const renders = vi.fn()

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    renders()
    latest = useNativeChatRetainedSession(props)
    return null
  }

  async function render(props: UseNativeChatLiveSessionArgs): Promise<void> {
    await act(async () => {
      root.render(createElement(Probe, props))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function emit(index: number, frame: unknown): Promise<void> {
    await act(async () => {
      subscriptions[index]?.onFrame(frame)
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    root = createRoot(document.createElement('div'))
    latest = null
    renders.mockClear()
    resetTransport()
    useAppStore.setState({ agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})) })
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  it('lets the pending read repair a stream error frame', async () => {
    const seed = deferred<{ messages: NativeChatMessage[] }>()
    transport.readSession.mockImplementationOnce(() => seed.promise)

    await render(BASE_ARGS)
    await emit(0, { type: 'snapshot', messages: [], hasMore: false, error: 'stream failed' })
    expect(latest?.status).toBe('error')

    await act(async () => {
      seed.resolve({ messages: [assistant('seeded', 1)] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest?.readPhase).toBe('ready')
    expect(latest?.messages.map((message) => message.id)).toEqual(['seeded'])
  })

  it('keeps the retained transcript when the reveal stream errors', async () => {
    await render(BASE_ARGS)
    await emit(0, {
      type: 'snapshot',
      messages: [assistant('committed', 1)],
      hasMore: false
    })
    await render({ ...BASE_ARGS, enabled: false })
    await render(BASE_ARGS)
    await emit(1, { type: 'snapshot', messages: [], hasMore: false, error: 'stream failed' })

    expect(latest?.messages.map((message) => message.id)).toEqual(['committed'])
    expect(latest?.status).not.toBe('error')
  })
})
