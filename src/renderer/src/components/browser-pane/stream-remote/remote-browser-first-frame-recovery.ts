import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { RemoteBrowserStreamLifecycleDeps } from './remote-browser-stream-lifecycle-deps'
import type { RemoteBrowserStreamLiveness } from './remote-browser-stream-liveness'
import type {
  RemoteBrowserOperationTokens,
  RemoteBrowserStreamToken
} from './remote-browser-stream-tokens'

const FIRST_FRAME_REPAINT_EXPRESSION =
  'document.documentElement?.animate?.([{ opacity: 1 }, { opacity: 1 }], { duration: 1 }); undefined'

type FirstFrameRecoveryDeps = Pick<
  RemoteBrowserStreamLifecycleDeps,
  'callRpc' | 'getWorktreeSelector'
> & {
  tokens: RemoteBrowserOperationTokens
  liveness: RemoteBrowserStreamLiveness
  handleClosed: (restart: boolean) => void
}

export function recoverRemoteBrowserFirstFrame(
  token: RemoteBrowserStreamToken,
  deps: FirstFrameRecoveryDeps
): void {
  if (!deps.tokens.isCurrentStreamToken(token)) {
    return
  }
  const signal = deps.liveness.startFirstFrameRecovery()
  if (!signal) {
    return
  }
  const target: RuntimeClientTarget = {
    kind: 'environment',
    environmentId: token.environmentId
  }
  const waitForFrame = (): void => {
    if (
      !deps.tokens.isCurrentStreamToken(token) ||
      !deps.liveness.finishFirstFrameRecovery(signal)
    ) {
      return
    }
    deps.liveness.waitForRecoveredFrame(() => {
      if (deps.tokens.isCurrentStreamToken(token)) {
        deps.handleClosed(true)
      }
    })
  }
  void deps
    .callRpc(
      target,
      'browser.eval',
      {
        worktree: deps.getWorktreeSelector(),
        page: token.remotePageId,
        expression: FIRST_FRAME_REPAINT_EXPRESSION
      },
      { timeoutMs: 5_000, suppressFeatureInteraction: true, signal }
    )
    .then(waitForFrame, waitForFrame)
}
