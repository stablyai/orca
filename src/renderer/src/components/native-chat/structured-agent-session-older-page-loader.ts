import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  oldestStructuredAgentSessionCursor,
  type StructuredAgentSessionAction
} from '../../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSessionReadSnapshot } from './structured-agent-session-read-owner-contract'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import { readStructuredAgentSessionOlderPage } from './structured-agent-session-older-page-read'

export function createStructuredAgentSessionOlderPageLoader({
  target,
  sessionId,
  getSnapshot,
  setSnapshot,
  apply,
  captureHistoryReadGuard
}: {
  target: RuntimeClientTarget | null
  sessionId: string
  getSnapshot: () => StructuredAgentSessionReadSnapshot
  setSnapshot: (next: StructuredAgentSessionReadSnapshot) => void
  apply: (action: StructuredAgentSessionAction) => void
  captureHistoryReadGuard: () => () => boolean
}): () => Promise<NativeChatOlderPageResult> {
  let olderPage: { shouldStop: () => boolean; promise: Promise<NativeChatOlderPageResult> } | null =
    null
  return () => {
    if (!target) {
      return Promise.resolve('superseded')
    }
    // Share concurrent page requests so another caller’s refusal cannot look like exhaustion.
    if (olderPage && !olderPage.shouldStop()) {
      return olderPage.promise
    }
    const shouldStop = captureHistoryReadGuard()
    if (shouldStop()) {
      return Promise.resolve('superseded')
    }
    if (!oldestStructuredAgentSessionCursor(getSnapshot().state) || !getSnapshot().state.hasOlder) {
      return Promise.resolve('exhausted')
    }
    setSnapshot({ ...getSnapshot(), loadingOlder: true })
    const promise = readStructuredAgentSessionOlderPage({
      target,
      sessionId,
      getState: () => getSnapshot().state,
      apply,
      shouldStop
    })
    const page = { shouldStop, promise }
    olderPage = page
    void page.promise.finally(() => {
      if (olderPage !== page) {
        return
      }
      olderPage = null
      if (!shouldStop()) {
        if (getSnapshot().loadingOlder) {
          setSnapshot({ ...getSnapshot(), loadingOlder: false })
        }
      }
    })
    return page.promise
  }
}
