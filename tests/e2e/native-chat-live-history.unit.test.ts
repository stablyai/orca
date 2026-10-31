// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const { transport, resetTransport } = vi.hoisted(() => {
  let listener: (frame: unknown) => void = () => {}
  const unsubscribe = vi.fn()
  const transport = {
    unsubscribe,
    readSession: vi.fn(),
    subscribe: vi.fn((_args, onFrame) => {
      listener = onFrame
      return unsubscribe
    }),
    emit: (frame: unknown) => listener(frame)
  }
  return {
    transport,
    resetTransport: () => {
      listener = () => {}
      transport.readSession.mockReset()
    }
  }
})

vi.mock('../../src/renderer/src/components/native-chat/native-chat-session-transport', () => ({
  getNativeChatSessionTransport: () => transport
}))

import {
  useNativeChatLiveSession,
  type NativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from '../../src/renderer/src/components/native-chat/use-native-chat-live-session'

describe('useNativeChatLiveSession — file watcher pagination composition', () => {
  const AGENT = 'claude' as const
  const SESSION = 'sess-1'
  const PANE = 'pane-1'
  const roots: Root[] = []
  let latest: NativeChatLiveSession | null = null

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    latest = useNativeChatLiveSession(props)
    return null
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function render(props: UseNativeChatLiveSessionArgs): Promise<Root> {
    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(createElement(Probe, props))
    })
    await flush()
    return root
  }

  beforeEach(() => {
    // Without it React warns on every act() and may not flush updates inside it.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    useAppStore.setState({ agentStatusByPaneKey: {} })
  })

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount())
    }
    latest = null
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    resetTransport()
  })

  it('keeps the original watcher append after a real 300-to-500 loadEarlier', async () => {
    // One budget shared by every step, just under the 30 s test timeout, so only the message changes.
    const budget = AbortSignal.timeout(27_000)
    const { mkdtemp, writeFile, appendFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readNativeChatTranscriptTail, subscribeNativeChatTranscript } =
      await import('../../src/main/native-chat/transcript-watch')
    const { createNativeChatMessageListProjection } =
      await import('../../src/renderer/src/components/native-chat/native-chat-message-list-projection')
    const directory = await mkdtemp(join(tmpdir(), 'pr31794-live-'))
    const filePath = join(directory, 'session.jsonl')
    const line = (n: number) =>
      `${JSON.stringify({
        type: 'assistant',
        uuid: String(n).padStart(4, '0'),
        timestamp: '2026-06-01T10:00:00Z',
        message: { role: 'assistant', content: `reply ${n}` }
      })}\n`
    await writeFile(filePath, Array.from({ length: 500 }, (_, i) => line(i + 1)).join(''))
    transport.readSession.mockImplementation((_agent, _session, limit) =>
      readNativeChatTranscriptTail({
        agent: AGENT,
        sessionId: SESSION,
        filePath,
        limit,
        sourceOrder: true
      })
    )
    const session = () => {
      if (!latest) {
        throw new Error('No live session')
      }
      return latest
    }
    const ids = () =>
      createNativeChatMessageListProjection()(session().messages).conversation.map((row) => row.id)
    await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-history'
    })
    // A CI run hit the 30 s test timeout with no step named; each wait names its own stall.
    const delivered: string[] = []
    const within = <T>(step: string, promise: Promise<T>): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          const stalled = (): void => {
            const rows = latest ? ids().length : null
            const limits = transport.readSession.mock.calls.map((call) => call[2])
            reject(
              new Error(
                `Stalled at ${step}: ${JSON.stringify({ delivered, rows, readSessionLimits: limits })}`
              )
            )
          }
          if (budget.aborted) {
            stalled()
          } else {
            budget.addEventListener('abort', stalled, { once: true })
          }
        })
      ])
    const initialSnapshotCommitted = Promise.withResolvers<void>()
    const appendCommitted = Promise.withResolvers<void>()
    const subscription = await subscribeNativeChatTranscript({
      agent: AGENT,
      sessionId: SESSION,
      filePath,
      sourceOrder: true,
      initialLimit: 300,
      debounceMs: 5,
      reconciliationIntervalMs: 20,
      onInitialSnapshot: (messages, hasMore) => {
        delivered.push(`snapshot:${messages.length}`)
        void act(async () => {
          transport.emit({ type: 'snapshot', messages, hasMore })
        }).then(initialSnapshotCommitted.resolve, initialSnapshotCommitted.reject)
      },
      onAppend: (messages) => {
        delivered.push(`append:${messages.length}`)
        void act(async () => {
          transport.emit({ type: 'appended', messages })
        }).then(appendCommitted.resolve, appendCommitted.reject)
      },
      onReplace: (messages, hasMore) => {
        delivered.push(`replace:${messages.length}`)
        return act(() => transport.emit({ type: 'replacement', messages, hasMore }))
      }
    })
    try {
      await within('initial snapshot', initialSnapshotCommitted.promise)
      expect(ids()).toEqual(Array.from({ length: 300 }, (_, i) => String(i + 201).padStart(4, '0')))
      await act(async () => {
        await expect(within('loadEarlier 300 to 500', session().loadEarlier())).resolves.toBe(
          'applied'
        )
      })
      expect(transport.readSession).toHaveBeenLastCalledWith(AGENT, SESSION, 500, undefined)
      expect(ids()).toEqual(Array.from({ length: 500 }, (_, i) => String(i + 1).padStart(4, '0')))
      await appendFile(filePath, line(501))
      await within('watcher append of line 501', appendCommitted.promise)
      expect(ids()).toEqual(Array.from({ length: 501 }, (_, i) => String(i + 1).padStart(4, '0')))
      expect(ids().at(-1)).toBe('0501')
      expect(transport.subscribe).toHaveBeenCalledOnce()
    } finally {
      subscription.unsubscribe()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
