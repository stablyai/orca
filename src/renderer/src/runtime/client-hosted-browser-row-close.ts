import { callRuntimeRpc } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const CLIENT_HOSTED_ROW_CLOSE_TIMEOUT_MS = 15_000

/** Close paired-client-rendered pages in this host’s local registry via browser.tabClose. Workspace reconciliation does not apply: this row owns no workspace/page record/environment mirror. An absent rendering client is skipped while retiring retained pages. */
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
