import { describe, expect, it, vi } from 'vitest'
import type {
  OmpRpcChatFetchHistoryArgs,
  OmpRpcChatFetchHistoryResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { hydrateOmpRpcChatHistory } from './omp-rpc-history-hydration'

const MESSAGE: NativeChatMessage = {
  id: 'omp-rpc-history-0',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'reply' }],
  timestamp: 1,
  source: 'rpc'
}

function makeApi(results: OmpRpcChatFetchHistoryResult[]) {
  const calls: OmpRpcChatFetchHistoryArgs[] = []
  const fetchHistory = vi.fn(async (args: OmpRpcChatFetchHistoryArgs) => {
    calls.push(args)
    return results[Math.min(calls.length - 1, results.length - 1)]
  })
  return { api: { fetchHistory }, calls, fetchHistory }
}

const immediately = async (): Promise<void> => undefined

describe('hydrateOmpRpcChatHistory', () => {
  it('publishes a drained snapshot once', async () => {
    const { api, fetchHistory } = makeApi([{ ok: true, messages: [MESSAGE], totalMessages: 1 }])
    const onHydrated = vi.fn()

    await hydrateOmpRpcChatHistory({ api, paneKey: 'pane-1', onHydrated, sleep: immediately })

    expect(fetchHistory).toHaveBeenCalledTimes(1)
    expect(onHydrated).toHaveBeenCalledExactlyOnceWith({
      messages: [MESSAGE],
      totalMessages: 1
    })
  })

  it('retries a session-busy refusal, which upstream returns while a turn streams', async () => {
    // rpc-mode.ts refuses to start a paging walk while streaming or compacting.
    // That is a retry-once-idle outcome, not a failure to degrade on.
    const { api, fetchHistory } = makeApi([
      { ok: false, reason: 'session-busy' },
      { ok: true, messages: [MESSAGE], totalMessages: 1 }
    ])
    const onHydrated = vi.fn()

    await hydrateOmpRpcChatHistory({ api, paneKey: 'pane-1', onHydrated, sleep: immediately })

    expect(fetchHistory).toHaveBeenCalledTimes(2)
    expect(onHydrated).toHaveBeenCalledTimes(1)
  })

  it('gives up on a bounded number of busy refusals rather than looping', async () => {
    const { api, fetchHistory } = makeApi([{ ok: false, reason: 'session-busy' }])
    const onHydrated = vi.fn()

    await hydrateOmpRpcChatHistory({
      api,
      paneKey: 'pane-1',
      onHydrated,
      sleep: immediately,
      maxAttempts: 3
    })

    expect(fetchHistory).toHaveBeenCalledTimes(3)
    expect(onHydrated).not.toHaveBeenCalled()
  })

  it('degrades to the transcript on an unavailable session without retrying', () => {
    // D1: no owned session, or a walk that could not complete — retrying it
    // would only delay the pane settling on what it can actually render.
    const { api, fetchHistory } = makeApi([{ ok: false, reason: 'unavailable' }])
    const onHydrated = vi.fn()

    return hydrateOmpRpcChatHistory({
      api,
      paneKey: 'pane-1',
      onHydrated,
      sleep: immediately
    }).then(() => {
      expect(fetchHistory).toHaveBeenCalledTimes(1)
      expect(onHydrated).not.toHaveBeenCalled()
    })
  })

  it('never publishes into a pane that has since been cancelled', async () => {
    // The pane can unmount or rebind while the drain is in flight; a snapshot
    // from the superseded session must not reach the one that replaced it.
    const { api } = makeApi([{ ok: true, messages: [MESSAGE], totalMessages: 1 }])
    const onHydrated = vi.fn()

    await hydrateOmpRpcChatHistory({
      api,
      paneKey: 'pane-1',
      onHydrated,
      sleep: immediately,
      isCancelled: () => true
    })

    expect(onHydrated).not.toHaveBeenCalled()
  })

  it('stops retrying once cancelled mid-backoff', async () => {
    const { api, fetchHistory } = makeApi([{ ok: false, reason: 'session-busy' }])
    let cancelled = false
    const onHydrated = vi.fn()

    await hydrateOmpRpcChatHistory({
      api,
      paneKey: 'pane-1',
      onHydrated,
      sleep: async () => {
        cancelled = true
      },
      isCancelled: () => cancelled,
      maxAttempts: 5
    })

    expect(fetchHistory).toHaveBeenCalledTimes(1)
    expect(onHydrated).not.toHaveBeenCalled()
  })

  it('swallows a rejected round trip rather than surfacing it to the pane', async () => {
    const api = {
      fetchHistory: vi.fn(async () => {
        throw new Error('IPC channel closed')
      })
    }
    const onHydrated = vi.fn()

    await expect(
      hydrateOmpRpcChatHistory({ api, paneKey: 'pane-1', onHydrated, sleep: immediately })
    ).resolves.toBeUndefined()
    expect(onHydrated).not.toHaveBeenCalled()
  })
})
