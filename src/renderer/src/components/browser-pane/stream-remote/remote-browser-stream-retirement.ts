import type { RemoteBrowserStreamLiveness } from './remote-browser-stream-liveness'
import type {
  RemoteBrowserOperationTokens,
  RemoteBrowserStreamSubscription
} from './remote-browser-stream-tokens'

export function releaseFailedRemoteBrowserStream(
  subscription: RemoteBrowserStreamSubscription | null,
  tokens: RemoteBrowserOperationTokens,
  liveness: RemoteBrowserStreamLiveness,
  current: boolean
): RemoteBrowserStreamSubscription | null {
  if (!current) {
    return subscription
  }
  subscription?.unsubscribe()
  liveness.clear()
  tokens.releaseStreamToken()
  return null
}

export function retireRemoteBrowserStreamWork(args: {
  tokens: RemoteBrowserOperationTokens
  liveness: RemoteBrowserStreamLiveness
  subscription: RemoteBrowserStreamSubscription | null
  cancelRestart: () => void
}): RemoteBrowserStreamSubscription | null {
  args.tokens.supersedeOperations()
  args.tokens.supersedeStream()
  args.tokens.releaseStreamToken()
  args.liveness.clear()
  args.cancelRestart()
  return args.subscription
}
