// @vitest-environment happy-dom
//
// The preview is an editor tab that has to read like a browser tab. These pin the parts of that
// illusion a reader can catch us on: the document names itself and its owning machine instead of
// showing the internal preview scheme, Back/Forward really drive the guest's history, and the chip
// hands over the path the owner spells rather than the one the grant was minted with.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { acquireWebviewsDragPassthrough } from '@/components/browser-pane/host-guest/webview-drag-passthrough'

const GRANT_ID = 'a'.repeat(32)
// The draw-tool hint's own storage key; the hook that owns it keeps it private.
const MARKUP_DRAW_HINT_SEEN_KEY = 'orca.browser.markup-draw-hint-seen'
const ENTRY_RELATIVE_PATH = 'docs/reports/index.html'
const ABSOLUTE_PATH = '/repo/docs/reports/index.html'

const clipboard = vi.hoisted(() => ({ writes: [] as string[] }))
const grabCalls: { browserPageId: string; enabled: boolean }[] = []
const osOpens: string[] = []

vi.mock('@/lib/doc-preview-grants', () => ({
  buildDocPreviewGrantRequest: () => ({
    owner: {
      kind: 'runtime' as const,
      environmentId: 'env-1',
      worktreeSelector: 'id:wt-1',
      worktreeRoot: '/repo'
    },
    root: '/repo',
    entryRelativePath: ENTRY_RELATIVE_PATH
  }),
  ensureDocPreviewGrant: () =>
    Promise.resolve({
      grantId: GRANT_ID,
      url: `orca-preview://${GRANT_ID}/${ENTRY_RELATIVE_PATH}`
    }),
  releaseDocPreviewGrant: () => undefined
}))

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  moveFocusToRendererBeforeWebviewDetach: () => undefined
}))

// The real one walks half the store to decide who owns a worktree; the chip only cares that
// whatever it decides reaches the pill.
vi.mock('@/lib/execution-host-display-label', () => ({
  selectWorktreeHostDisplayLabel: () => 'Studio Mac mini'
}))

const store = vi.hoisted(() => ({
  openedFiles: [] as unknown[],
  downloads: [] as string[],
  pageStateUpdates: [] as { pageId: string; updates: { title?: string } }[]
}))

// The document lives on the SSH host that owns the workspace, which is what makes the preview a
// preview at all — the client OS has no copy of it.
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
  options: { holdsGuestFocus?: boolean } = {}
): Promise<StubWebview> {
  const { HtmlDocPreview } = await import('./HtmlDocPreview')
  await act(async () => {
    root.render(
      <TooltipProvider>
        <HtmlDocPreview
          previewId="preview-1"
          filePath={ABSOLUTE_PATH}
          relativePath={ENTRY_RELATIVE_PATH}
          worktreeId="wt-1"
          holdsGuestFocus={options.holdsGuestFocus ?? false}
        />
      </TooltipProvider>
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

  it('identifies the document by its workspace path and owning machine', async () => {
    await renderPreview(container, root)

    const text = container.textContent ?? ''
    expect(text).toContain('docs/reports/')
    expect(text).toContain('index.html')
    expect(text).toContain('Workspace file')
    expect(text).toContain('Studio Mac mini')
  })

  // The internal scheme is an implementation detail of how the workspace hands bytes to the guest.
  // The guest's own src attribute necessarily carries it; no other node in the tree may.
  it('never shows the internal preview scheme to the reader', async () => {
    const webview = await renderPreview(container, root)

    expect(webview.getAttribute('src')).toContain('orca-preview')
    const withoutGuest = container.cloneNode(true) as HTMLElement
    for (const guest of withoutGuest.querySelectorAll('webview')) {
      guest.remove()
    }
    expect(withoutGuest.innerHTML).not.toContain('orca-preview')
  })

  // Why this is a drag bug and not a styling one: a <webview> takes the pointer stream the
  // document never sees, so a tab drag stops getting pointermove the moment the cursor crosses
  // the preview — the dragged tab stops following the cursor and the split cannot be dropped.
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

  // Why append time and not the enrolling effect: dragging the preview's OWN tab across a split
  // remounts this component mid-drag, and an effect settles a turn later — for the rest of that
  // turn the fresh guest is hittable and eats the pointer stream, which is the original freeze.
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

  // Why: the chip sits in the row's height-pinned slot, and a wrapper of its own between the two
  // would leave it its natural height again — the toolbar would shrink for document tabs.
  it('hands the identity chip straight to the height-pinned address slot', async () => {
    await renderPreview(container, root)

    const chip = button(container, 'Copy file path')
    const slot = container.querySelector('[data-browser-chrome-address-slot]')
    expect(slot).not.toBeNull()
    expect(chip.parentElement).toBe(slot)
    expect(chip.className).not.toMatch(/(^|\s)h-/)
  })

  // Browser parity: a browser tab is named by the document it shows. What the document names is
  // the tab; what it must never rename is the chip, which is the reader's only proof of which
  // file on which host they are looking at.
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
    expect(button(container, 'Copy file path').textContent).toContain(ENTRY_RELATIVE_PATH)
  })

  // Why: the browsing tour walks anchors by name, and a preview answering to the browser pane's
  // anchors would hand it steps about profiles and cookies that a document tab does not have.
  it('claims none of the browsing tour anchors', async () => {
    await renderPreview(container, root)

    expect(container.querySelector('[data-contextual-tour-target]')).toBeNull()
  })

  it('copies the absolute path the owning machine spells, not the workspace-relative one', async () => {
    await renderPreview(container, root)

    await act(async () => {
      button(container, 'Copy file path').click()
    })

    expect(clipboard.writes).toEqual([ABSOLUTE_PATH])
    // The icon swap alone says nothing to a screen reader, so the control renames itself.
    expect(button(container, 'Copied')).not.toBeNull()
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
    // Why: a disabled edge control must be inert, not merely dimmed.
    expect(goForward).not.toHaveBeenCalled()
  })

  // Fragment links navigate in-document, which is still a history entry a reader expects Back to
  // unwind — the guest reports it on a different event than a full navigation.
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

    // Why: cookies land in a browsing session, and a preview reads workspace disk over a grant —
    // there is no session for an import to reach.
    it('hides cookie import, which a preview has no session for', async () => {
      await renderPreview(container, root)

      expect(container.querySelector('button[aria-label="Import cookies from browser"]')).toBeNull()
    })

    // The picker is driven through main, which resolves the page to whichever guest is rendering
    // this document now — so the id it sends is the page, not the grant a re-mint would replace.
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

    // Why: a preview is a remote document by construction — the client OS has no copy to launch,
    // so "open externally" has to download first.
    it('downloads a runtime-owned document before handing it to the OS', async () => {
      await renderPreview(container, root)

      await act(async () => {
        button(container, 'Open with default app').click()
      })

      expect(store.downloads).toEqual([ABSOLUTE_PATH])
      expect(osOpens).toEqual([])
    })

    // Why the storage flag and not the popover: the nudge fires once per install, and the harm is
    // consuming that one view — a reader who opened a document would spend the browsing pane's
    // introduction to a tool they were not shown.
    it('never spends the once-per-install draw-tool hint', async () => {
      window.localStorage.removeItem(MARKUP_DRAW_HINT_SEEN_KEY)

      await renderPreview(container, root)

      expect(window.localStorage.getItem(MARKUP_DRAW_HINT_SEEN_KEY)).toBeNull()
    })
  })

  // Why it has to be somewhere: the preview hides the editor's path header, and the relative path
  // was only ever copyable from there — the chip and the menu both give the absolute one.
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

// Why this is a test and not left to the pane: main answers a reported link click only from a
// focused guest, so a preview whose guest never takes focus has no route out at all — the failure
// is silent, and only the reader pressing a link ever sees it.
describe('HtmlDocPreview guest focus', () => {
  let container: HTMLDivElement
  let root: Root
  let focused: Element[]
  let focusSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    focused = []
    focusSpy = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function (this: HTMLElement) {
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

    // And the window coming back does not reopen the offer a preview behind a terminal refused.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await settleFrames()

    expect(focused).not.toContain(webview)
  })

  // Why the window's own focus has to re-offer: another app taking the front pulls focus out of the
  // guest, and coming back lands it on the embedder. The guest is where a clicked link is reported
  // from, so without this the route out of the preview stays shut until something remounts it.
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

  // Why that re-offer has to yield: the window also gets focus back when the reader presses a tab,
  // because the guest holding the keyboard is what blurred the embedder. Taking it back from there
  // fights the reader for their own click.
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
