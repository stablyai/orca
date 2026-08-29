import type { Page } from '@stablyai/playwright-test'

/**
 * Census for the paired HTML preview journey. Since STA-5557 the preview is a client-local
 * *browser* page located by a workspace document and served over `orca-preview://`, so the two
 * halves of the oracle point in opposite directions: the client must gain exactly one browser
 * workspace — the document one — while the host gains no browser page at all.
 */
export type PairedHtmlPreviewInventory = {
  hostResponseOk: boolean
  hostResponseError: string | null
  /**
   * Every browser page the host itself holds for the worktree: its own, plus the ones clients
   * publish to it. Why this and not `session.tabs.list`: a headless host projects only terminals
   * into that snapshot, so asking it whether a preview reached the host answers "no" whether or
   * not the preview was ever held back. This reads the registry a published page lands in.
   */
  hostBrowserPages: { id: string; url: string; title: string }[]
  /** The same question through the tab snapshot, which is what a mobile or web client sees. */
  hostSessionBrowserTabs: { id: string; url: string }[]
  clientBrowserWorkspaceCount: number
  /** Why every workspace and not just this one: a routed-out link opens in whichever workspace is
   *  active, so a per-worktree count could miss a tab that really was created. */
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
    // Why named here: RPC results cross the preload boundary as `unknown`, so this is the one
    // place the shapes read below are asserted.
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

/** The one document row, or a failure naming how many there actually were. */
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

/**
 * Reads the rendered document out of the preview guest. The guest is a real `<webview>` on its
 * own partition, so Playwright cannot reach into it directly — the embedder evaluates for us.
 */
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

/**
 * Viewport point of an element inside the preview guest. Playwright cannot target a node in a
 * webview, so the guest reports the rect and the embedder adds the webview's own offset — a real
 * mouse press there is the only click Chromium treats as a user gesture.
 *
 * Returns null until the guest's own hit test at that point resolves to the element, so a caller
 * polling on it cannot click a rect that layout is still moving.
 */
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

/**
 * Records every external link the preview routes into a browser tab. The click that triggers this
 * crosses into a guest process, so without the record a missing tab cannot distinguish a press
 * Chromium swallowed from a tab the workspace refused to create.
 */
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

/** Every preview guest in the client renderer, with the layout it actually has. */
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
