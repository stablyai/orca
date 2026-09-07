import type {
  BrowserPage,
  BrowserPageDocLocation,
  BrowserWorkspace
} from '../../../../shared/browser-workspace-types'
import { browserPageDocLocationsEqual } from '../../../../shared/browser-page-doc-location'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import { isDocPreviewUrl } from '../../../../shared/doc-preview-scheme'
import { basename } from '@/lib/path'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'

export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed.length === 0) {
    return 'about:blank'
  }
  // Why: redact at this single URL sink so the Kagi bearer token can't reach BrowserPage.url, which is persisted to disk.
  return redactKagiSessionToken(trimmed)
}

export function normalizeBrowserTitle(
  title: string | null | undefined,
  url: string,
  docLocation?: BrowserPageDocLocation | null
): string {
  if (docLocation) {
    // Why a document page cannot go through the checks below: its url is the blank URL by design,
    // which would name every previewed document "New Tab". Its fallback is the file it shows.
    // Why the grant URL is refused rather than trusted: Chromium reports the URL as the title when
    // a document declares none, and this title is stored, persisted and mirrored onto the tab —
    // a grant reaching any of them would outlive the grant and name a document nothing can read.
    if (!title || isDocPreviewUrl(title)) {
      return basename(docLocation.filePath) || docLocation.filePath
    }
    return title
  }
  if (
    url === 'about:blank' ||
    url === ORCA_BROWSER_BLANK_URL ||
    title === 'about:blank' ||
    title === ORCA_BROWSER_BLANK_URL ||
    !title
  ) {
    // Why: don't surface the internal blank-guest URL as a title (leaks an impl detail, looks broken); show "New Tab" instead.
    return 'New Tab'
  }
  return title
}

export function buildBrowserPage(
  workspaceId: string,
  worktreeId: string,
  url: string,
  title?: string,
  browserRuntimeEnvironmentId?: string | null,
  browserPageId?: string,
  docLocation?: BrowserPageDocLocation
): BrowserPage {
  // Why the url is overridden rather than trusted: this is the one place a page's url is minted,
  // and it is read by persistence, the mobile publisher, history and the address bar. A grant URL
  // reaching any of them would outlive the grant and name a document that machine cannot read.
  const normalizedUrl = docLocation ? ORCA_BROWSER_BLANK_URL : normalizeUrl(url)
  return {
    id: browserPageId ?? createBrowserUuid(),
    workspaceId,
    worktreeId,
    url: normalizedUrl,
    title: normalizeBrowserTitle(title, normalizedUrl, docLocation),
    // Why: blank pages mount an inert guest (no real navigation); marking them loading would flash the loading affordance.
    loading: normalizedUrl !== 'about:blank' && normalizedUrl !== ORCA_BROWSER_BLANK_URL,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: Date.now(),
    ...(browserRuntimeEnvironmentId !== undefined ? { browserRuntimeEnvironmentId } : {}),
    ...(docLocation ? { docLocation } : {})
  }
}

export function buildWorkspaceFromPage(
  id: string,
  worktreeId: string,
  page: BrowserPage,
  pageIds: string[],
  sessionProfileId?: string | null,
  sessionPartition?: string | null
): BrowserWorkspace {
  return {
    id,
    worktreeId,
    sessionProfileId: sessionProfileId ?? null,
    sessionPartition: sessionPartition ?? null,
    activePageId: page.id,
    pageIds,
    url: page.url,
    title: page.title,
    loading: page.loading,
    faviconUrl: page.faviconUrl,
    canGoBack: page.canGoBack,
    canGoForward: page.canGoForward,
    loadError: page.loadError,
    createdAt: page.createdAt,
    docLocation: page.docLocation ?? null
  }
}

export function mirrorWorkspaceFromActivePage(
  workspace: BrowserWorkspace,
  pages: BrowserPage[]
): BrowserWorkspace {
  const activePage = pages.find((page) => page.id === workspace.activePageId) ?? null
  if (!activePage) {
    return {
      ...workspace,
      activePageId: null,
      pageIds: pages.map((page) => page.id),
      url: 'about:blank',
      title: translate('auto.store.slices.browser.08fc23631d', 'Browser'),
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      docLocation: null
    }
  }
  return {
    ...workspace,
    activePageId: activePage.id,
    pageIds: pages.map((page) => page.id),
    url: activePage.url,
    title: activePage.title,
    loading: activePage.loading,
    faviconUrl: activePage.faviconUrl,
    canGoBack: activePage.canGoBack,
    canGoForward: activePage.canGoForward,
    loadError: activePage.loadError,
    docLocation: activePage.docLocation ?? null
  }
}

export function browserWorkspaceMirrorFieldsEqual(
  workspace: BrowserWorkspace,
  mirrored: BrowserWorkspace
): boolean {
  const workspacePageIds = workspace.pageIds ?? []
  const mirroredPageIds = mirrored.pageIds ?? []
  return (
    workspace.activePageId === mirrored.activePageId &&
    workspacePageIds.length === mirroredPageIds.length &&
    workspacePageIds.every((pageId, index) => pageId === mirroredPageIds[index]) &&
    workspace.url === mirrored.url &&
    workspace.title === mirrored.title &&
    workspace.loading === mirrored.loading &&
    workspace.faviconUrl === mirrored.faviconUrl &&
    workspace.canGoBack === mirrored.canGoBack &&
    workspace.canGoForward === mirrored.canGoForward &&
    workspace.loadError === mirrored.loadError &&
    browserPageDocLocationsEqual(workspace.docLocation ?? null, mirrored.docLocation ?? null)
  )
}

const browserWorkspaceByIdCache = new WeakMap<
  Record<string, BrowserWorkspace[]>,
  Map<string, BrowserWorkspace>
>()
const browserPageByIdCache = new WeakMap<Record<string, BrowserPage[]>, Map<string, BrowserPage>>()

export function findWorkspace(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  workspaceId: string
): BrowserWorkspace | null {
  const cached = browserWorkspaceByIdCache.get(browserTabsByWorktree)
  if (cached) {
    return cached.get(workspaceId) ?? null
  }
  const workspaceById = new Map<string, BrowserWorkspace>()
  for (const workspaces of Object.values(browserTabsByWorktree)) {
    for (const workspace of workspaces) {
      workspaceById.set(workspace.id, workspace)
    }
  }
  browserWorkspaceByIdCache.set(browserTabsByWorktree, workspaceById)
  return workspaceById.get(workspaceId) ?? null
}

export function findPage(
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  pageId: string
): BrowserPage | null {
  const cached = browserPageByIdCache.get(browserPagesByWorkspace)
  if (cached) {
    return cached.get(pageId) ?? null
  }
  const pageById = new Map<string, BrowserPage>()
  for (const pages of Object.values(browserPagesByWorkspace)) {
    for (const page of pages) {
      pageById.set(page.id, page)
    }
  }
  browserPageByIdCache.set(browserPagesByWorkspace, pageById)
  return pageById.get(pageId) ?? null
}
