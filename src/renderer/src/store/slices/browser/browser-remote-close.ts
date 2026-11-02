import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isBrowserPageDefinitivelyGone } from '@/runtime/client-hosted-browser-close-intent-replay'
import { isDurableClientHostedBrowserHandle } from '@/runtime/client-hosted-browser-close-intents'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { PendingClientHostedBrowserClose } from '@/runtime/client-hosted-browser-close-intents'
import type { RemoteBrowserPageHandle } from './browser-slice-contract'

export function closeRemoteBrowserPageInOwningEnvironment(
  worktreeId: string,
  handle: RemoteBrowserPageHandle,
  // Inject recorder callback: module scope runs while its owning slice is still being defined.
  recordCloseIntents: (closes: readonly PendingClientHostedBrowserClose[]) => void
): void {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId: handle.environmentId }
  void callRuntimeRpc(
    target,
    'browser.tabClose',
    { worktree: toRuntimeWorktreeSelector(worktreeId), page: handle.remotePageId },
    { timeoutMs: 15_000 }
  ).catch((error) => {
    // Persist undelivered close for reconnect because runtime persists client-hosted pages. Definitive page-unknown proves nothing can resurrect.
    if (!isDurableClientHostedBrowserHandle(handle) || isBrowserPageDefinitivelyGone(error)) {
      return
    }
    recordCloseIntents([
      { environmentId: handle.environmentId, browserPageId: handle.remotePageId, worktreeId }
    ])
  })
}
