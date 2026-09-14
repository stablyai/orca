import { callRuntimeRpc } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const CLIENT_HOSTED_ROW_CLOSE_TIMEOUT_MS = 15_000

/**
 * Closes a browser page that renders on a paired client, from the HOST's own UI.
 *
 * Deliberately not routed through closeBrowserWorkspaceTabOnHosts: that plan reconciles a
 * renderer-owned workspace tab across the environments mirroring it, and this row owns no
 * workspace, no page record, and no environment mirror. `browser.tabClose` on the local runtime is
 * the whole operation — it retires the registry page and, when the client that placed it is gone,
 * skips asking the absent host so a retained page can still be dismissed.
 */
export async function closeClientHostedBrowserRow(args: {
  worktreeId: string
  browserPageId: string
}): Promise<void> {
  await callRuntimeRpc(
    { kind: 'local' },
    'browser.tabClose',
    {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      page: args.browserPageId
    },
    { timeoutMs: CLIENT_HOSTED_ROW_CLOSE_TIMEOUT_MS }
  )
}
