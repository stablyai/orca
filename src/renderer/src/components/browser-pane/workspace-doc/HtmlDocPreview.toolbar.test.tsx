// @vitest-environment happy-dom
import { act } from 'react'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type * as WebviewRegistryModule from '../host-guest/webview-registry'
import type * as DocPreviewArtifactShareModule from './doc-preview-artifact-share'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { acquireWebviewsDragPassthrough } from '@/components/browser-pane/host-guest/webview-drag-passthrough'

const confirmExternalLink = async (): Promise<boolean> => false

const GRANT_ID = 'a'.repeat(32)

const ENTRY_RELATIVE_PATH = 'docs/reports/index.html'
const ABSOLUTE_PATH = '/repo/docs/reports/index.html'

const clipboard = vi.hoisted(() => ({ writes: [] as string[] }))
const grabCalls: { browserPageId: string; enabled: boolean }[] = []
const osOpens: string[] = []

const grants = vi.hoisted(() => {
  const mintedLocation = {
    owner: {
      kind: 'runtime' as const,
      environmentId: 'env-1',
      worktreeSelector: 'id:wt-1',
      worktreeRoot: '/repo'
    },
    requestBase: '/repo',
    root: '/repo',
    entryRelativePath: 'docs/reports/index.html'
  }
  const shareControlCalls: unknown[][] = []
  return { mintedLocation, requestLocation: mintedLocation, shareControlCalls }
})

vi.mock('@/lib/doc-preview-grants', () => ({
  buildDocPreviewGrantRequest: () => grants.requestLocation,
  // The real cache keeps the first mint's handle for the tab, whatever a later request says.
  ensureDocPreviewGrant: () =>
    Promise.resolve({
      grantId: GRANT_ID,
      url: `orca-preview://${GRANT_ID}/${ENTRY_RELATIVE_PATH}`,
      location: grants.mintedLocation
    }),
  releaseDocPreviewGrant: () => undefined
}))

vi.mock('./doc-preview-artifact-share', async (importOriginal) => {
  const actual = await importOriginal<typeof DocPreviewArtifactShareModule>()
  return {
    ...actual,
    buildDocPreviewShareControl: (
      ...args: Parameters<typeof actual.buildDocPreviewShareControl>
    ) => {
      grants.shareControlCalls.push(args)
      return actual.buildDocPreviewShareControl(...args)
    }
  }
})

vi.mock('@/components/browser-pane/host-guest/webview-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof WebviewRegistryModule>()),
  moveFocusToRendererBeforeWebviewDetach: () => undefined
}))

vi.mock('@/lib/execution-host-display-label', () => ({
  selectWorktreeHostDisplayLabel: () => 'Studio Mac mini'
}))

const store = vi.hoisted(() => ({
  openedFiles: [] as unknown[],
  downloads: [] as string[],
  pageStateUpdates: [] as { pageId: string; updates: { title?: string } }[],
  conversions: [] as { pageId: string; target: unknown }[]
}))

// The document lives only on its workspace’s SSH host.
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => 'ssh-1',
  getConnectionIdForFile: () => 'ssh-1',
  getConnectionIdFromState: () => 'ssh-1'
}))

vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: () => 'ssh-1',
  getConnectionIdFromState: () => 'ssh-1'
}))

vi.mock('@/components/terminal-pane/links/files/terminal-remote-file-download-open', () => ({
  downloadAndOpenRemoteTerminalFile: (_context: unknown, filePath: string) => {
    store.downloads.push(filePath)
    return Promise.resolve()
  }
}))

const storeState = {
  getKnownWorktreeById: () => ({ path: '/repo' }),
  persistedUIReady: true,
  settings: { activeRuntimeEnvironmentId: 'env-1' },
  keybindings: {},
  browserAnnotationsByPageId: {} as Record<string, unknown[]>,
  activeGroupIdByWorktree: {} as Record<string, string>,
  agentSendPopoverTargetMode: null,
  openAgentSendPopoverTargetMode: () => undefined,
  closeAgentSendPopoverTargetMode: () => undefined,
  addBrowserPageAnnotation: () => undefined,
  deleteBrowserPageAnnotation: () => undefined,
  clearBrowserPageAnnotations: () => undefined,
  recordFeatureInteraction: () => undefined,
  openFile: (file: unknown) => {
    store.openedFiles.push(file)
    return 'file-1'
  },
  updateBrowserPageState: (pageId: string, updates: { title?: string }) => {
    store.pageStateUpdates.push({ pageId, updates })
  },
  browserUrlHistory: [],
  browserPagesByWorkspace: {},
  workspaceDocHistory: [],
  recordWorkspaceDocVisit: () => undefined,
  browserDefaultSearchEngine: 'google',
  browserKagiSessionLink: null,
  convertBrowserPage: (pageId: string, target: unknown) => {
    store.conversions.push({ pageId, target })
    return { id: 'converted-1' }
  }
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    { getState: () => storeState }
  )
}))

type StubWebview = Element & {
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
}

async function renderPreview(
  container: HTMLDivElement,
  root: Root,
  options: { holdsGuestFocus?: boolean; isActive?: boolean } = {}
): Promise<StubWebview> {
  const { HtmlDocPreview } = await import('./HtmlDocPreview')
  await act(async () => {
    root.render(
      <ConfirmationDialogContext.Provider value={confirmExternalLink}>
        <TooltipProvider>
          <HtmlDocPreview
            isActive={options.isActive ?? true}
            previewId="preview-1"
            browserWorkspaceId="browser-1"
            filePath={ABSOLUTE_PATH}
            relativePath={ENTRY_RELATIVE_PATH}
            worktreeId="wt-1"
            holdsGuestFocus={options.holdsGuestFocus ?? false}
          />
        </TooltipProvider>
      </ConfirmationDialogContext.Provider>
    )
  })
  const webview = container.querySelector('webview') as StubWebview | null
  expect(webview).not.toBeNull()
  // Why: the tools only arm once something has painted, so every case starts from a settled load.
  await act(async () => {
    webview?.dispatchEvent(new Event('did-stop-loading'))
  })
  return webview as StubWebview
}

describe('HtmlDocPreview browser chrome', () => {
  let container: HTMLDivElement
  let root: Root
  let mounted = false

  beforeEach(() => {
    mounted = true
    clipboard.writes = []
    store.openedFiles = []
    store.downloads = []
    grabCalls.length = 0
    osOpens.length = 0
    ;(window as unknown as { api: unknown }).api = {
      docPreview: { onLoadFailure: () => () => undefined },
      ui: {
        writeClipboardText: (text: string) => {
          clipboard.writes.push(text)
          return Promise.resolve()
        },
        writeClipboardImage: () => Promise.resolve()
      },
      shell: {
        openFilePath: (filePath: string) => {
          osOpens.push(filePath)
          return Promise.resolve(true)
        }
      },
      browser: {
        unregisterGuest: () => Promise.resolve(),
        setGrabMode: (args: { browserPageId: string; enabled: boolean }) => {
          grabCalls.push(args)
          return Promise.resolve({ ok: true })
        },
        cancelGrab: () => Promise.resolve(true),
        awaitGrabSelection: () => new Promise(() => {}),
        captureSelectionScreenshot: () => Promise.resolve({ ok: false }),
        setAnnotationViewportBridge: () => Promise.resolve(true)
      }
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (mounted) {
      act(() => root.unmount())
      mounted = false
    }
    container.remove()
  })

  it('counts document guests in the workspace budget and restores only on activation', async () => {
    const { hasLiveBrowserGuest, webviewRegistry } = await import('../host-guest/webview-registry')
    const { worktreeHoldsLiveBrowserGuests, selectBrowserGuestEvictionWorktreeIds } =
      await import('../host-guest/browser-guest-worktree-retention')
    const { destroyWorktreeBrowserGuests } =
      await import('@/store/slices/browser/cleanup/browser-webview-cleanup')
    const guest = await renderPreview(container, root)
    expect(hasLiveBrowserGuest('preview-1')).toBe(true)
    expect(await renderPreview(container, root, { isActive: false })).toBe(guest)
    const page: BrowserPage = {
      id: 'preview-1',
      workspaceId: 'browser-1',
      worktreeId: 'wt-1',
      url: 'about:blank',
      title: 'Report',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1,
      docLocation: { kind: 'workspace-doc', worktreeId: 'wt-1', filePath: ABSOLUTE_PATH }
    }
    const browsers: BrowserWorkspace[] = [{ ...page, id: 'browser-1', pageIds: [page.id] }]
    const pages: Record<string, BrowserPage[]> = { 'browser-1': [page] }
    const evicted = selectBrowserGuestEvictionWorktreeIds({
      orderedWorktreeIds: ['wt-1'],
      activeWorktreeId: 'wt-2',
      limit: 0,
      isRetained: () => true,
      isEvictable: () => true,
      holdsLiveGuests: () => worktreeHoldsLiveBrowserGuests(browsers, pages, hasLiveBrowserGuest)
    })
    expect(evicted).toEqual(['wt-1'])
    await act(async () => {
      destroyWorktreeBrowserGuests({ 'wt-1': browsers }, pages, 'wt-1')
    })
    expect(guest.isConnected).toBe(false)
    expect(hasLiveBrowserGuest('preview-1')).toBe(false)
    expect(container.querySelector('webview')).toBeNull()
    const restored = await renderPreview(container, root)
    expect(restored).not.toBe(guest)
    expect(webviewRegistry.get('preview-1')).toBe(restored)
    expect(await renderPreview(container, root, { isActive: false })).toBe(restored)
    expect(await renderPreview(container, root)).toBe(restored)
    await act(async () => root.unmount())
    mounted = false
    expect(hasLiveBrowserGuest('preview-1')).toBe(false)
  })

  // Mid-drag remount must be click-through at append time; a later effect leaves a turn that can swallow the drag.
  it('holds a guest that appears mid-drag click-through the moment it is appended', async () => {
    const appendedPointerEvents: string[] = []
    const originalAppendChild = HTMLElement.prototype.appendChild
    HTMLElement.prototype.appendChild = function <T extends Node>(node: T): T {
      const element = node as unknown as HTMLElement
      if (element.tagName?.toLowerCase() === 'webview') {
        appendedPointerEvents.push(element.style.pointerEvents)
      }
      return originalAppendChild.call(this, node) as T
    }
    const release = acquireWebviewsDragPassthrough()

    try {
      await renderPreview(container, root)
      expect(appendedPointerEvents).toEqual(['none'])
    } finally {
      HTMLElement.prototype.appendChild = originalAppendChild
      release()
    }
  })
})
