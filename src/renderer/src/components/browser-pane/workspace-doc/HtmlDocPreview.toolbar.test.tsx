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
// The draw-tool hint's own storage key; the hook that owns it keeps it private.
const MARKUP_DRAW_HINT_SEEN_KEY = 'orca.browser.markup-draw-hint-seen'
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
  getConnectionIdForFileFromState: () => 'ssh-1'
}))

vi.mock('@/components/terminal-pane/terminal-remote-file-download-open', () => ({
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

function stubHistory(
  webview: StubWebview,
  depth: { canGoBack: boolean; canGoForward: boolean }
): { goBack: ReturnType<typeof vi.fn>; goForward: ReturnType<typeof vi.fn> } {
  const goBack = vi.fn()
  const goForward = vi.fn()
  webview.canGoBack = () => depth.canGoBack
  webview.canGoForward = () => depth.canGoForward
  webview.goBack = goBack
  webview.goForward = goForward
  webview.reload = vi.fn()
  return { goBack, goForward }
}

function button(container: HTMLDivElement, label: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(element).not.toBeNull()
  return element as HTMLButtonElement
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
    const { destroyWorktreeBrowserGuests } = await import('@/store/slices/browser-webview-cleanup')
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

  it('shares through the minted grant even after the workspace resolves to another host', async () => {
    grants.shareControlCalls.length = 0
    await renderPreview(container, root)
    expect(grants.shareControlCalls.at(-1)).toEqual([ABSOLUTE_PATH, grants.mintedLocation])
    expect(button(container, 'Share as artifact')).not.toBeNull()

    grants.requestLocation = {
      ...grants.mintedLocation,
      owner: { ...grants.mintedLocation.owner, environmentId: 'env-2' }
    }
    storeState.settings = { activeRuntimeEnvironmentId: 'env-2' }
    try {
      await renderPreview(container, root)
      expect(grants.shareControlCalls.at(-1)).toEqual([ABSOLUTE_PATH, grants.mintedLocation])
    } finally {
      grants.requestLocation = grants.mintedLocation
      storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }
    }
  })

  it('identifies the document by its workspace path and owning machine', async () => {
    await renderPreview(container, root)

    const text = container.textContent ?? ''
    expect(text).toContain('docs/reports/')
    expect(text).toContain('index.html')
    expect(text).toContain('Workspace file')
    expect(text).toContain('Studio Mac mini')
  })

  it('never shows the internal preview scheme to the reader', async () => {
    const webview = await renderPreview(container, root)

    expect(webview.getAttribute('src')).toContain('orca-preview')
    const withoutGuest = container.cloneNode(true) as HTMLElement
    for (const guest of withoutGuest.querySelectorAll('webview')) {
      guest.remove()
    }
    expect(withoutGuest.innerHTML).not.toContain('orca-preview')
  })

  // Guests consume pointer events outside the document; passthrough must preserve renderer tab dragging.
  it('holds the guest click-through while a renderer drag is in flight', async () => {
    const webview = await renderPreview(container, root)

    const guest = webview as unknown as HTMLElement
    let release: (() => void) | null = null
    expect(guest.style.pointerEvents).toBe('')

    await act(async () => {
      release = acquireWebviewsDragPassthrough()
    })
    expect(guest.style.pointerEvents).toBe('none')

    await act(async () => release?.())
    expect(guest.style.pointerEvents).toBe('')
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

  it('hands the identity chip straight to the height-pinned address slot', async () => {
    await renderPreview(container, root)

    const chip = button(container, 'Edit address')
    const slot = container.querySelector('[data-browser-chrome-address-slot]')
    expect(slot).not.toBeNull()
    expect(chip.parentElement).toBe(slot)
    expect(chip.className).not.toMatch(/(^|\s)h-/)
  })

  // The document may rename its tab; the chip must keep proving file and host identity.
  it('lets the document name its tab while the chip keeps naming the file', async () => {
    const webview = await renderPreview(container, root)
    store.pageStateUpdates.length = 0

    await act(async () => {
      const event = new Event('page-title-updated')
      Object.assign(event, { title: 'Quarterly Report' })
      webview.dispatchEvent(event)
    })

    expect(store.pageStateUpdates).toEqual([
      { pageId: 'preview-1', updates: { title: 'Quarterly Report' } }
    ])
    expect(button(container, 'Edit address').textContent).toContain(ENTRY_RELATIVE_PATH)
  })

  // Committed web URLs convert the preview; its guest policy would refuse navigating them.
  it('edits the address in place and converts a committed URL instead of navigating', async () => {
    await renderPreview(container, root)
    store.conversions.length = 0

    await act(async () => {
      button(container, 'Edit address').click()
    })
    const input = container.querySelector<HTMLInputElement>(
      '[data-browser-chrome-address-slot] input'
    )
    expect(input).not.toBeNull()
    expect(input?.value).toBe(ENTRY_RELATIVE_PATH)

    await act(async () => {
      input!.value = 'https://example.com/'
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(store.conversions).toEqual([
      { pageId: 'preview-1', target: { kind: 'web', url: 'https://example.com/' } }
    ])
  })

  // First Escape closes suggestions; the second leaves editing without converting the page.
  it('returns to the chip on Escape without converting', async () => {
    await renderPreview(container, root)
    store.conversions.length = 0

    await act(async () => {
      button(container, 'Edit address').click()
    })
    const input = container.querySelector<HTMLInputElement>(
      '[data-browser-chrome-address-slot] input'
    )
    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(store.conversions).toEqual([])
    expect(button(container, 'Edit address')).not.toBeNull()
  })

  // Preview anchors must not enroll the document in a browsing tour about profiles and cookies.
  it('claims none of the browsing tour anchors', async () => {
    await renderPreview(container, root)

    expect(container.querySelector('[data-contextual-tour-target]')).toBeNull()
  })

  it('copies the absolute path the owning machine spells, not the workspace-relative one', async () => {
    await renderPreview(container, root)

    await act(async () => {
      // Why not click(): the Radix trigger opens on pointerdown, which happy-dom does not synthesize.
      button(container, 'Preview options').dispatchEvent(
        new window.PointerEvent('pointerdown', { bubbles: true, button: 0 })
      )
    })
    const absoluteCopy = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) =>
        item.textContent?.includes('Copy file path') &&
        !item.textContent.includes('Copy relative path')
    )
    expect(absoluteCopy).toBeDefined()

    await act(async () => {
      ;(absoluteCopy as HTMLElement).click()
    })

    expect(clipboard.writes).toEqual([ABSOLUTE_PATH])
  })

  it('starts with both history controls disabled', async () => {
    await renderPreview(container, root)

    expect(button(container, 'Back').disabled).toBe(true)
    expect(button(container, 'Forward').disabled).toBe(true)
  })

  it('enables Back once the guest has somewhere to go back to and drives the guest', async () => {
    const webview = await renderPreview(container, root)
    const { goBack, goForward } = stubHistory(webview, { canGoBack: true, canGoForward: false })

    await act(async () => {
      webview.dispatchEvent(new Event('did-navigate'))
    })

    expect(button(container, 'Back').disabled).toBe(false)
    expect(button(container, 'Forward').disabled).toBe(true)

    await act(async () => {
      button(container, 'Back').click()
      button(container, 'Forward').click()
    })

    expect(goBack).toHaveBeenCalledTimes(1)
    expect(goForward).not.toHaveBeenCalled()
  })

  // Fragment history arrives on a distinct event but must still support Back.
  it('tracks in-document navigation as history too', async () => {
    const webview = await renderPreview(container, root)
    stubHistory(webview, { canGoBack: true, canGoForward: true })

    await act(async () => {
      webview.dispatchEvent(new Event('did-navigate-in-page'))
    })

    expect(button(container, 'Back').disabled).toBe(false)
    expect(button(container, 'Forward').disabled).toBe(false)
  })

  it('still reloads the guest in place from the toolbar', async () => {
    const webview = await renderPreview(container, root)
    stubHistory(webview, { canGoBack: false, canGoForward: false })

    await act(async () => {
      button(container, 'Reload preview').click()
    })

    expect(webview.reload).toHaveBeenCalledTimes(1)
  })

  describe('tools', () => {
    it('offers the same tool cluster the browsing pane does', async () => {
      await renderPreview(container, root)

      for (const label of [
        'Grab page element',
        'Annotate page element',
        'Draw on screenshot',
        'Open source file',
        'Open with default app',
        'Preview options'
      ]) {
        expect(button(container, label)).not.toBeNull()
      }
    })

    it('hides cookie import, which a preview has no session for', async () => {
      await renderPreview(container, root)

      expect(container.querySelector('button[aria-label="Import cookies from browser"]')).toBeNull()
    })

    // Main resolves the current guest by stable page ID; grants change on re-mint.
    it('arms the element picker against the page the document is open in', async () => {
      await renderPreview(container, root)

      await act(async () => {
        button(container, 'Grab page element').click()
      })

      expect(grabCalls).toEqual([{ browserPageId: 'preview-1', enabled: true }])
    })

    it('opens the document source as its own editor tab', async () => {
      await renderPreview(container, root)

      await act(async () => {
        button(container, 'Open source file').click()
      })

      expect(store.openedFiles).toEqual([
        expect.objectContaining({
          filePath: ABSOLUTE_PATH,
          relativePath: ENTRY_RELATIVE_PATH,
          worktreeId: 'wt-1',
          mode: 'edit'
        })
      ])
    })

    // Remote documents need downloading before the client OS can open them.
    it('downloads a runtime-owned document before handing it to the OS', async () => {
      await renderPreview(container, root)

      await act(async () => {
        button(container, 'Open with default app').click()
      })

      expect(store.downloads).toEqual([ABSOLUTE_PATH])
      expect(osOpens).toEqual([])
    })

    // Check the storage flag so a preview cannot consume the once-per-install browsing hint.
    it('never spends the once-per-install draw-tool hint', async () => {
      window.localStorage.removeItem(MARKUP_DRAW_HINT_SEEN_KEY)

      await renderPreview(container, root)

      expect(window.localStorage.getItem(MARKUP_DRAW_HINT_SEEN_KEY)).toBeNull()
    })
  })

  // The hidden editor header no longer exposes the relative path; preserve a copy action.
  it('still offers the workspace-relative path the hidden editor header used to copy', async () => {
    await renderPreview(container, root)

    await act(async () => {
      // Why not click(): the Radix trigger opens on pointerdown, which happy-dom does not synthesize.
      button(container, 'Preview options').dispatchEvent(
        new window.PointerEvent('pointerdown', { bubbles: true, button: 0 })
      )
    })
    const relativeCopy = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('Copy relative path')
    )
    expect(relativeCopy).toBeDefined()

    await act(async () => {
      ;(relativeCopy as HTMLElement).click()
    })

    expect(clipboard.writes).toEqual([ENTRY_RELATIVE_PATH])
  })
})

describe('HtmlDocPreview guest focus', () => {
  let container: HTMLDivElement
  let root: Root
  let focused: Element[]
  let focusSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    focused = []
    focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement
    ) {
      focused.push(this)
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    focusSpy.mockRestore()
  })

  async function settleFrames(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
  }

  it('hands the guest focus once the preview is the surface the reader is in', async () => {
    const webview = await renderPreview(container, root, { holdsGuestFocus: true })
    await settleFrames()

    expect(focused).toContain(webview)
  })

  it('leaves focus alone while the reader is looking at something else', async () => {
    const webview = await renderPreview(container, root, { holdsGuestFocus: false })
    await settleFrames()

    expect(focused).not.toContain(webview)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await settleFrames()

    expect(focused).not.toContain(webview)
  })

  // Returning window focus lands on the embedder; offer it back to the guest for keyboard and link input.
  it('offers the guest focus again after the window gets it back', async () => {
    const webview = await renderPreview(container, root, { holdsGuestFocus: true })
    await settleFrames()
    focused.length = 0

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await settleFrames()

    expect(focused).toContain(webview)
  })

  // Window focus may follow the reader clicking another tab; never reclaim their chosen target.
  it('leaves focus with whatever claimed it when the window comes back', async () => {
    const webview = await renderPreview(container, root, { holdsGuestFocus: true })
    await settleFrames()
    focused.length = 0

    const claimant = document.createElement('button')
    document.body.append(claimant)
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => claimant
    })

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await settleFrames()

    expect(focused).not.toContain(webview)
    Reflect.deleteProperty(document, 'activeElement')
    claimant.remove()
  })
})
