import type { RemoteBrowserPageSession } from './remote-browser-page-session'
import {
  isRemoteBrowserPageMissingError,
  resolveRemoteBrowserStreamRestartFailure
} from './remote-browser-stream-errors'
import {
  remoteBrowserStreamRetrying,
  remoteBrowserStreamStopped,
  type RemoteBrowserStreamStatus
} from './remote-browser-stream-status'
import {
  toOperationToken,
  type RemoteBrowserOperationTokens,
  type RemoteBrowserStreamSubscription,
  type RemoteBrowserStreamToken
} from './remote-browser-stream-tokens'
import type { BrowserTabInfo } from '../../../../../shared/runtime-types'

export type RemoteBrowserStreamRestartAttemptDeps = {
  tokens: RemoteBrowserOperationTokens
  session: RemoteBrowserPageSession
  setStatus: (status: RemoteBrowserStreamStatus) => void
  applyTabInfo: (tab: BrowserTabInfo) => void
  closeMissingRemotePage: (remotePageId: string) => void
  startStream: (pageId: string) => Promise<RemoteBrowserStreamSubscription | null>
  adoptSubscription: (subscription: RemoteBrowserStreamSubscription) => void
}

// One self-heal attempt for a dropped stream, as the scheduler wants it: resolves true to keep
// retrying, false to stop. Split from the lifecycle because a single attempt needs none of the
// lifecycle's own state — only the token it is retrying on behalf of.
export function createRemoteBrowserStreamRestartAttempt(
  token: RemoteBrowserStreamToken,
  deps: RemoteBrowserStreamRestartAttemptDeps
): () => Promise<boolean> {
  const { tokens } = deps
  // Keeps a failure visible across the wait before the next attempt instead of blinking off.
  let lastNotice: string | null = null
  return async (): Promise<boolean> => {
    if (!tokens.isCurrentStreamOperation(token)) {
      return false
    }
    deps.setStatus(remoteBrowserStreamRetrying(lastNotice))
    const operationToken = toOperationToken(token)
    try {
      const tab = await deps.session.fetchTabInfo(operationToken).catch(() => null)
      if (tab && tokens.isCurrentStreamOperation(token)) {
        deps.applyTabInfo(tab)
      }
      if (!tokens.isCurrentStreamOperation(token)) {
        return false
      }
      const subscription = await deps.startStream(token.remotePageId)
      if (subscription) {
        deps.adoptSubscription(subscription)
      }
      return false
    } catch (error) {
      if (!tokens.isCurrentStreamOperation(token)) {
        return false
      }
      if (isRemoteBrowserPageMissingError(error)) {
        deps.closeMissingRemotePage(token.remotePageId)
        return false
      }
      const failure = resolveRemoteBrowserStreamRestartFailure(error)
      if (failure.logRawError) {
        // The raw text is transport-level and written for logs; keep it out of the UI but not out of
        // reach, since nothing else records it.
        console.warn('[browser-pane] remote stream restart failed:', error)
      }
      // Why giving up publishes 'stopped': abandoning automatic retries is not the same as taking
      // away the user's last resort, and a classification we got wrong would otherwise strand the
      // pane exactly as it did before this work. While attempts remain it stays 'retrying', which
      // reports the failure without offering a control that competes with the next attempt.
      lastNotice = failure.message
      deps.setStatus(
        failure.shouldRetry
          ? remoteBrowserStreamRetrying(failure.message)
          : remoteBrowserStreamStopped(failure.message)
      )
      return failure.shouldRetry
    }
  }
}
