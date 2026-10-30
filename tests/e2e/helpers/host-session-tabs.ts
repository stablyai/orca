import type { RuntimeClient } from '../../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-types'

// Read authoritative host tabs directly so a copied client ownership policy cannot weaken close assertions.
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

// Use browser.tabList: headless session snapshots omit browsers and CLI capabilities hide client-placed pages.
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

// Read the host’s current page URL, which is the recovery destination for client-hosted tabs.
export async function readHostBrowserPageUrl(
  hostClient: RuntimeClient,
  repoPath: string,
  browserPageId: string
): Promise<string | null> {
  const tabs = await readHostBrowserPages(hostClient, `path:${repoPath}`)
  return tabs.find((tab) => tab.browserPageId === browserPageId)?.url ?? null
}

// Accept workspace selectors for folder workspaces; allow initial browser startup beyond the paired client’s default 5s timeout.
export async function readHostBrowserPageUrls(
  hostClient: RuntimeClient,
  worktreeSelector: string
): Promise<string[]> {
  const tabs = await readHostBrowserPages(hostClient, worktreeSelector, 15_000)
  return tabs.map((tab) => tab.url)
}
