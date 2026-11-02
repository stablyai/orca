import type { RemoteBrowserPageSession } from './remote-browser-page-session'
import {
  isRemoteBrowserPageMissingError,
  resolveRemoteBrowserStreamFailure
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

// One self-heal attempt for a dropped stream: resolves true to keep retrying, false to stop.
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
      const failure = resolveRemoteBrowserStreamFailure(error)
      if (failure.logRawError) {
        // The raw transport text stays out of the UI, so this log is its only record.
        console.warn('[browser-pane] remote stream restart failed:', error)
      }
      // Why: giving up still publishes 'stopped' so a misclassified failure stays manually recoverable.
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
