import type { OmpRpcChatAcquireResult } from '../../../../shared/omp-rpc-chat-ipc-contract'

const RETRY_DELAY_MS = 250
const RETRY_WINDOW_MS = 5_000

export async function retryOmpRpcAcquireAfterConflict(args: {
  initialResult: OmpRpcChatAcquireResult
  retriesAfterPreviousAcquire: boolean
  acquire: () => Promise<OmpRpcChatAcquireResult>
  shouldContinue: () => boolean
  onExtendedRetry: () => void
}): Promise<OmpRpcChatAcquireResult> {
  let result = args.initialResult
  const deadline =
    Date.now() + (args.retriesAfterPreviousAcquire ? RETRY_WINDOW_MS : RETRY_DELAY_MS)
  while (
    !result.ok &&
    result.reason === 'conflict' &&
    args.shouldContinue() &&
    Date.now() < deadline
  ) {
    if (args.retriesAfterPreviousAcquire) {
      args.onExtendedRetry()
    }
    await delay(Math.min(RETRY_DELAY_MS, deadline - Date.now()))
    if (args.shouldContinue()) {
      result = await args.acquire()
    }
  }
  return result
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
