import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isBrowserPageDefinitivelyGone } from '@/runtime/client-hosted-browser-close-intent-replay'
import { isDurableClientHostedBrowserHandle } from '@/runtime/client-hosted-browser-close-intents'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { PendingClientHostedBrowserClose } from '@/runtime/client-hosted-browser-close-intents'
import type { RemoteBrowserPageHandle } from './browser-slice-contract'

export function closeRemoteBrowserPageInOwningEnvironment(
  worktreeId: string,
  handle: RemoteBrowserPageHandle,
  // Why a callback and not the store: this is module scope, and the recording action lives on the
  // slice this file is still defining.
  recordCloseIntents: (closes: readonly PendingClientHostedBrowserClose[]) => void
): void {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId: handle.environmentId }
  void callRuntimeRpc(
    target,
    'browser.tabClose',
    { worktree: toRuntimeWorktreeSelector(worktreeId), page: handle.remotePageId },
    { timeoutMs: 15_000 }
  ).catch((error) => {
    // A close the runtime never heard is a resurrection waiting to happen: the runtime persists
    // client-hosted pages, so a durable intent replays this same RPC on the next reconnect.
    // A definitive page-unknown answer means there is nothing left to resurrect.
    if (!isDurableClientHostedBrowserHandle(handle) || isBrowserPageDefinitivelyGone(error)) {
      return
    }
    recordCloseIntents([
      { environmentId: handle.environmentId, browserPageId: handle.remotePageId, worktreeId }
    ])
  })
}
