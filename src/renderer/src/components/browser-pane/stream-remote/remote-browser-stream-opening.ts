import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { RuntimeStatus } from '../../../../../shared/runtime-types'
import { openRemoteBrowserScreencastStream } from './remote-browser-screencast-subscription'
import { createRemoteBrowserStreamEvents } from './remote-browser-stream-events'
import type { RemoteBrowserStreamLifecycleDeps } from './remote-browser-stream-lifecycle-deps'
import type { RemoteBrowserStreamLiveness } from './remote-browser-stream-liveness'
import { releaseFailedRemoteBrowserStream } from './remote-browser-stream-retirement'
import { remoteBrowserStreamUnsupportedError } from './remote-browser-stream-errors'
import type {
  RemoteBrowserOperationTokens,
  RemoteBrowserStreamSubscription,
  RemoteBrowserStreamToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'

type RemoteBrowserStreamOpeningContext = {
  deps: RemoteBrowserStreamLifecycleDeps
  tokens: RemoteBrowserOperationTokens
  liveness: RemoteBrowserStreamLiveness
  pageId: string
  getSubscription: () => RemoteBrowserStreamSubscription | null
  setSubscription: (subscription: RemoteBrowserStreamSubscription | null) => void
  onClosed: (token: RemoteBrowserStreamToken, restart: boolean) => void
  onSubscriptionStart: (
    token: RemoteBrowserStreamToken,
    handle: { unsubscribe: () => void }
  ) => void
  prepareViewport: (size: RemoteBrowserViewportSize | null) => RemoteBrowserViewportSize | null
}

export async function startRemoteBrowserStream(
  context: RemoteBrowserStreamOpeningContext
): Promise<RemoteBrowserStreamSubscription | null> {
  const { deps, tokens, liveness, pageId } = context
  const operationToken = tokens.createOperationToken(pageId)
  if (!operationToken || !tokens.isCurrent(operationToken)) {
    return null
  }
  const target: RuntimeClientTarget = {
    kind: 'environment',
    environmentId: operationToken.environmentId
  }
  const status = await deps.callRpc<RuntimeStatus>(target, 'status.get', undefined, {
    timeoutMs: 15_000
  })
  if (!status.capabilities?.includes('browser.screencast.v1')) {
    throw remoteBrowserStreamUnsupportedError()
  }
  if (!tokens.isCurrent(operationToken)) {
    return null
  }
  const measuredViewportSize = await deps.waitForViewportSize()
  if (!tokens.isCurrent(operationToken)) {
    return null
  }
  const viewportSize = context.prepareViewport(measuredViewportSize)
  const token = tokens.claimStreamToken(operationToken, pageId)
  liveness.watch(() => {
    if (tokens.isCurrentStreamToken(token)) {
      context.onClosed(token, true)
    }
  })
  try {
    const subscription = await openRemoteBrowserScreencastStream(
      deps.subscribeScreencast,
      {
        environmentId: target.environmentId,
        worktree: deps.getWorktreeSelector(),
        pageId,
        viewportSize,
        deviceScaleFactor: deps.getDeviceScaleFactor()
      },
      createRemoteBrowserStreamEvents(pageId, token, viewportSize, {
        ...deps,
        tokens,
        liveness,
        handleClosed: (restart) => context.onClosed(token, restart),
        onSubscriptionStart: (handle) => context.onSubscriptionStart(token, handle)
      })
    )
    return { token, unsubscribe: subscription.unsubscribe }
  } catch (error) {
    context.setSubscription(
      releaseFailedRemoteBrowserStream(
        context.getSubscription(),
        tokens,
        liveness,
        tokens.isCurrentStreamToken(token)
      )
    )
    throw error
  }
}
