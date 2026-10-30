import type { Page } from '@stablyai/playwright-test'

// Client-local previews must add one document browser workspace while adding no browser page on the host (STA-5557).
export type PairedHtmlPreviewInventory = {
  hostResponseOk: boolean
  hostResponseError: string | null
  // Inspect the host browser registry; a headless session-tab snapshot omits browsers and would pass even for leaked pages.
  hostBrowserPages: { id: string; url: string; title: string }[]
  /** The same question through the tab snapshot, which is what a mobile or web client sees. */
  hostSessionBrowserTabs: { id: string; url: string }[]
  clientBrowserWorkspaceCount: number
  // Count all workspaces because routed links can open under whichever workspace is active.
  clientBrowserWorkspaceCountAllWorktrees: number
  /** The client rows this document is open in — the preview, in browser-tab terms. */
  docWorkspaces: DocPreviewWorkspaceRow[]
  /** Editor rows for the retired preview species; a restore that resurrects one shows up here. */
  htmlPreviewEditorFileIds: string[]
}

export type DocPreviewWorkspaceRow = {
  groupId: string | null
  pageId: string
  pageUrl: string
  title: string
  unifiedTabId: string | null
  workspaceId: string
  /** Mirrored onto the workspace as well as the page; both must name the document. */
  workspaceDocFilePath: string | null
  workspaceUrl: string
}

export async function readPairedHtmlPreviewInventory(
  page: Page,
  args: {
    environmentId: string
    docFilePath: string
    worktreeId: string
  }
): Promise<PairedHtmlPreviewInventory> {
  return page.evaluate(async ({ environmentId, docFilePath, worktreeId }) => {
    const call = async (method: string) =>
      window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params: { worktree: `id:${worktreeId}` },
        timeoutMs: 15_000
      })
    const [pagesResponse, tabsResponse] = await Promise.all([
      call('browser.tabList'),
      call('session.tabs.list')
    ])
    const state = window.__store?.getState()
    // Narrow unknown preload replies once at this read boundary.
    const hostPages = pagesResponse.ok
      ? (pagesResponse.result as { tabs: { browserPageId: string; url: string; title: string }[] })
          .tabs
      : []
    const hostTabs = tabsResponse.ok
      ? (tabsResponse.result as { tabs: { id: string; type: string; url: string }[] }).tabs
      : []
    const workspaces = state?.browserTabsByWorktree[worktreeId] ?? []
    const unifiedTabs = state?.unifiedTabsByWorktree[worktreeId] ?? []
    const docWorkspaces: DocPreviewWorkspaceRow[] = []
    for (const workspace of workspaces) {
      for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
        if (browserPage.docLocation?.filePath !== docFilePath) {
          continue
        }
        const unifiedTab = unifiedTabs.find(
          (tab) => tab.contentType === 'browser' && tab.entityId === workspace.id
        )
        docWorkspaces.push({
          groupId: unifiedTab?.groupId ?? null,
          pageId: browserPage.id,
          pageUrl: browserPage.url,
          title: browserPage.title,
          unifiedTabId: unifiedTab?.id ?? null,
          workspaceId: workspace.id,
          workspaceDocFilePath: workspace.docLocation?.filePath ?? null,
          workspaceUrl: workspace.url
        })
      }
    }
    return {
      hostResponseOk: pagesResponse.ok && tabsResponse.ok,
      hostResponseError: JSON.stringify(
        [pagesResponse, tabsResponse].filter((response) => !response.ok)
      ),
      hostBrowserPages: hostPages.map((hostPage) => ({
        id: hostPage.browserPageId,
        title: hostPage.title,
        url: hostPage.url
      })),
      hostSessionBrowserTabs: hostTabs
        .filter((tab) => tab.type === 'browser')
        .map((tab) => ({ id: tab.id, url: tab.url })),
      clientBrowserWorkspaceCount: workspaces.length,
      clientBrowserWorkspaceCountAllWorktrees: Object.values(
        state?.browserTabsByWorktree ?? {}
      ).reduce((total, tabs) => total + tabs.length, 0),
      docWorkspaces,
      htmlPreviewEditorFileIds: (state?.openFiles ?? [])
        .filter((file) => file.id.startsWith('html-preview::'))
        .map((file) => file.id)
    }
  }, args)
}

export function requireSingleDocWorkspace(
  inventory: PairedHtmlPreviewInventory
): DocPreviewWorkspaceRow {
  if (inventory.docWorkspaces.length !== 1) {
    throw new Error(
      `expected exactly one document browser workspace, saw ${inventory.docWorkspaces.length}`
    )
  }
  return inventory.docWorkspaces[0]!
}

// Read through the embedder because Playwright cannot directly enter a real webview’s separate partition.
export async function readDocPreviewRenderedText(
  page: Page,
  selector: string
): Promise<string | null> {
  return page.evaluate(async (targetSelector) => {
    const guest = document.querySelector('webview[src^="orca-preview://"]') as {
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    if (!guest?.executeJavaScript) {
      return null
    }
    try {
      const text = await guest.executeJavaScript(
        `document.querySelector(${JSON.stringify(targetSelector)})?.textContent ?? null`
      )
      return typeof text === 'string' ? text : null
    } catch {
      // Why: the guest rejects until it is attached and dom-ready; the caller polls.
      return null
    }
  }, selector)
}

// Combine guest rect with webview offset for a real Chromium user-gesture click.
// Return null until the guest’s hit test agrees so moving layout cannot target a stale rect.
export async function readDocPreviewElementCenter(
  page: Page,
  selector: string
): Promise<{ x: number; y: number } | null> {
  return page.evaluate(async (targetSelector) => {
    const guest = document.querySelector('webview[src^="orca-preview://"]') as
      | (HTMLElement & { executeJavaScript?: (code: string) => Promise<unknown> })
      | null
    if (!guest?.executeJavaScript) {
      return null
    }
    try {
      const rect = (await guest.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(targetSelector)});
          if (!el) { return null }
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          return el.contains(document.elementFromPoint(x, y)) ? { x, y } : null })()`
      )) as { x: number; y: number } | null
      if (!rect) {
        return null
      }
      const hostRect = guest.getBoundingClientRect()
      if (hostRect.width === 0 || hostRect.height === 0) {
        return null
      }
      return { x: hostRect.left + rect.x, y: hostRect.top + rect.y }
    } catch {
      return null
    }
  }, selector)
}

type RoutedPreviewLink = { url: string; opened: boolean }

// Record routed links so swallowed guest clicks can be distinguished from refused tab creation.
export async function armPairedHtmlPreviewLinkRouting(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('paired client exposed no store to observe link routing')
    }
    const routed: RoutedPreviewLink[] = []
    ;(window as unknown as { __routedPreviewLinks: RoutedPreviewLink[] }).__routedPreviewLinks =
      routed
    const original = store.getState().openBrowserProfileTabInActiveWorkspace
    store.setState({
      openBrowserProfileTabInActiveWorkspace: async (url: string, profileId: string | null) => {
        const opened = await original(url, profileId)
        routed.push({ url, opened })
        return opened
      }
    } as never)
  })
}

export async function readPairedHtmlPreviewLinkRouting(page: Page): Promise<RoutedPreviewLink[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __routedPreviewLinks?: RoutedPreviewLink[] }).__routedPreviewLinks ??
      []
  )
}

export async function readDocPreviewGuestRects(
  page: Page
): Promise<{ src: string; width: number; height: number; hiddenAncestor: boolean }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('webview[src^="orca-preview://"]')].map((node) => {
      const element = node as HTMLElement
      const rect = element.getBoundingClientRect()
      return {
        src: element.getAttribute('src') ?? '',
        width: rect.width,
        height: rect.height,
        hiddenAncestor: element.closest('[hidden]') !== null
      }
    })
  )
}

export async function readDocPreviewGuestUrl(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('webview[src^="orca-preview://"]')?.getAttribute('src') ?? null
  )
}
