import type { RuntimeClient } from '../../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-types'

/**
 * The host's own view of a worktree's session tabs. Asking the host directly is what makes a close
 * test a real oracle: a client-side re-derivation of who owns the tab stops guarding the moment the
 * ownership policy it copied changes.
 */
export async function readHostTabs(
  hostClient: RuntimeClient,
  repoPath: string
): Promise<RuntimeMobileSessionTabsResult> {
  const response = await hostClient.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `path:${repoPath}`
  })
  return response.result
}

type HostBrowserPageRow = { browserPageId: string; url: string }

/**
 * The host's own browser page registry for a workspace, addressed by worktree selector.
 *
 * Why not readHostTabs: a headless paired host does not project browser pages into
 * session.tabs.list — that snapshot carries only terminals, and it additionally hides client-placed
 * pages from any peer that does not advertise `BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY`, which the
 * CLI socket deliberately does not. `browser.tabList` has neither limitation, so it is the only
 * oracle that answers "does the host still hold this page" for both placements.
 */
async function readHostBrowserPages(
  hostClient: RuntimeClient,
  worktreeSelector: string,
  timeoutMs?: number
): Promise<HostBrowserPageRow[]> {
  const response = await hostClient.call<{ tabs: HostBrowserPageRow[] }>(
    'browser.tabList',
    { worktree: worktreeSelector },
    { timeoutMs }
  )
  return response.result.tabs
}

/** The page ids the host still holds for a repo-backed worktree. */
export async function readHostBrowserPageIds(
  hostClient: RuntimeClient,
  repoPath: string
): Promise<string[]> {
  const tabs = await readHostBrowserPages(hostClient, `path:${repoPath}`)
  return tabs.map((tab) => tab.browserPageId).sort()
}

/**
 * Where the host believes one of its browser pages is.
 *
 * For a client-hosted page this is the record the client keeps current by publishing metadata, and
 * it is the URL page recovery navigates a restored page back to — so it is the difference between
 * restoring a tab and restoring it where the user actually was.
 */
export async function readHostBrowserPageUrl(
  hostClient: RuntimeClient,
  repoPath: string,
  browserPageId: string
): Promise<string | null> {
  const tabs = await readHostBrowserPages(hostClient, `path:${repoPath}`)
  return tabs.find((tab) => tab.browserPageId === browserPageId)?.url ?? null
}

/**
 * Every browser page URL the host holds, for callers that address the workspace by selector
 * (`id:`/`path:`) rather than repo path — a folder workspace has no repo path.
 *
 * Why the explicit ceiling: a paired host's client is constructed with a 5s default, which the
 * first tabList can outrun while the host brings its browser session up.
 */
export async function readHostBrowserPageUrls(
  hostClient: RuntimeClient,
  worktreeSelector: string
): Promise<string[]> {
  const tabs = await readHostBrowserPages(hostClient, worktreeSelector, 15_000)
  return tabs.map((tab) => tab.url)
}
