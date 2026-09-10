// Drives one reconnect history hydration for an RPC-owned pane.
//
// Kept out of the ownership hook so the retry policy is testable without React:
// the only outcome worth retrying is `session-busy`, which is upstream refusing
// to start a paging walk while the session streams or compacts (rpc-mode.ts).
// `unavailable` is a D1 degrade — the pane keeps rendering its transcript — and
// retrying it would only delay that.

import type {
  OmpRpcChatFetchHistoryArgs,
  OmpRpcChatFetchHistoryResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/** Just the IPC surface this needs, so a caller can pass a stub. */
type FetchHistoryApi = {
  fetchHistory: (args: OmpRpcChatFetchHistoryArgs) => Promise<OmpRpcChatFetchHistoryResult>
}

/** Bounded like the ownership hook's conflict retry: a session that is still
 *  busy after this many tries is streaming a long turn, and the next
 *  hydration attempt belongs to a later acquire, not to a spin here. */
const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_RETRY_DELAY_MS = 750

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Resolves once the snapshot has been published or given up on — never throws,
 * and never publishes into a pane that has been cancelled (unmounted, or
 * rebound to a different RPC session) since the drain started.
 */
export async function hydrateOmpRpcChatHistory(args: {
  api: FetchHistoryApi
  paneKey: string
  onHydrated: (snapshot: { messages: NativeChatMessage[]; totalMessages: number }) => void
  limit?: number
  isCancelled?: () => boolean
  maxAttempts?: number
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const {
    api,
    paneKey,
    onHydrated,
    limit,
    isCancelled = () => false,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleep = wait
  } = args

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isCancelled()) {
      return
    }
    let result: OmpRpcChatFetchHistoryResult
    try {
      result = await api.fetchHistory({ paneKey, ...(limit === undefined ? {} : { limit }) })
    } catch {
      return
    }
    if (isCancelled()) {
      return
    }
    if (result.ok) {
      onHydrated({ messages: result.messages, totalMessages: result.totalMessages })
      return
    }
    if (result.reason !== 'session-busy' || attempt === maxAttempts) {
      return
    }
    await sleep(retryDelayMs)
  }
}
