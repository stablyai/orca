// @vitest-environment happy-dom
//
// The preview guest paints the handler's error body as if it were the document, so every
// unreadable outcome arrives out-of-band on the failure channel. These pin that each reason
// reaches the reader as its own sentence, and that a broken subresource cannot blank the page.
//
// The payloads here are the ones the reader can actually produce. The entry document is served as
// text by every owner, so it fails only as too-large (a host-reported truncation) or unreadable (a
// read error or a revoked grant); 'unsupported-asset' comes from a subresource whose format the
// host declined to send — a font, say — and never from the document itself.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DocPreviewFailure } from '../../../../../shared/doc-preview-scheme'

const GRANT_ID = 'a'.repeat(32)
const REMINTED_GRANT_ID = 'c'.repeat(32)
const ENTRY_RELATIVE_PATH = 'doc.html'

const grantRuntime = vi.hoisted(() => ({
  mints: 0,
  released: [] as string[],
  authorizations: [] as { grantId: string; relativePath: string }[]
}))

vi.mock('@/lib/doc-preview-grants', () => ({
  buildDocPreviewGrantRequest: () => ({
    owner: {
      kind: 'runtime' as const,
      environmentId: 'env-1',
      worktreeSelector: 'id:wt-1',
      worktreeRoot: '/repo'
    },
    requestBase: '/repo',
    root: '/repo/docs',
    entryRelativePath: ENTRY_RELATIVE_PATH
  }),
  ensureDocPreviewGrant: () => {
    grantRuntime.mints += 1
    // Why a fresh id per mint: a re-mint after a reconnect must bind the guest to the new grant.
    const grantId = grantRuntime.mints === 1 ? GRANT_ID : REMINTED_GRANT_ID
    return Promise.resolve({ grantId, url: `orca-preview://${grantId}/${ENTRY_RELATIVE_PATH}` })
  },
  releaseDocPreviewGrant: (previewId: string) => {
    grantRuntime.released.push(previewId)
  }
}))

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  moveFocusToRendererBeforeWebviewDetach: () => undefined
}))

const storeState = {
  getKnownWorktreeById: () => ({ path: '/repo' }),
  persistedUIReady: true,
  settings: {},
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
  openFile: () => 'file-1'
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    { getState: () => storeState }
  )
}))

vi.mock('@/lib/execution-host-display-label', () => ({
  selectWorktreeHostDisplayLabel: () => 'Studio Mac mini'
}))

const failureListeners: ((payload: DocPreviewFailure) => void)[] = []

function emitFailure(payload: DocPreviewFailure): void {
  for (const listener of failureListeners.slice()) {
    listener(payload)
  }
}

async function renderPreview(container: HTMLDivElement, root: Root): Promise<void> {
  const { HtmlDocPreview } = await import('./HtmlDocPreview')
  await act(async () => {
    root.render(
      <TooltipProvider>
        <HtmlDocPreview
          previewId="preview-1"
          filePath="/repo/docs/doc.html"
          relativePath="docs/doc.html"
          worktreeId="wt-1"
        />
      </TooltipProvider>
    )
  })
  expect(container.querySelector('webview')).not.toBeNull()
}

describe('HtmlDocPreview failure messages', () => {
  let container: HTMLDivElement
  let root: Root
  let mounted = false

  beforeEach(() => {
    mounted = true
    failureListeners.length = 0
    grantRuntime.mints = 0
    grantRuntime.released = []
    grantRuntime.authorizations = []
    ;(window as unknown as { api: unknown }).api = {
      docPreview: {
        authorizeDirectory: (grantId: string, relativePath: string) => {
          grantRuntime.authorizations.push({ grantId, relativePath })
          return Promise.resolve(true)
        },
        onLoadFailure: (callback: (payload: DocPreviewFailure) => void) => {
          failureListeners.push(callback)
          return () => {
            const index = failureListeners.indexOf(callback)
            if (index !== -1) {
              failureListeners.splice(index, 1)
            }
          }
        }
      },
      ui: { writeClipboardText: () => Promise.resolve() },
      browser: { setAnnotationViewportBridge: () => Promise.resolve(true) }
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

  it('tells the reader the document is too large instead of showing a bare failure', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: ENTRY_RELATIVE_PATH, reason: 'too-large' })
    })

    expect(container.textContent).toContain(
      'This document is too large to preview. Open it in the editor instead.'
    )
  })

  // Why a notice and not the panel: the document rendered. Hiding it behind a failure screen would
  // take away a page the reader can use over one asset the workspace would not send.
  it('names the asset the workspace refused without hiding the document', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'assets/inter.woff2',
        reason: 'unsupported-asset'
      })
    })

    expect(container.textContent).toContain(
      'This workspace cannot send assets/inter.woff2 to a preview.'
    )
    expect(container.textContent).not.toContain('Preview unavailable')
    expect(container.querySelector('webview')).not.toBeNull()
  })

  it('names an unreadable or over-cap asset by path', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: 'assets/logo.png', reason: 'unreadable' })
    })

    expect(container.textContent).toContain(
      'Orca could not read assets/logo.png from the workspace.'
    )

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: 'assets/data.json', reason: 'too-large' })
    })

    expect(container.textContent).toContain('2 files in this document could not be loaded.')
    expect(container.textContent).not.toContain('Preview unavailable')
  })

  it('counts each failing asset once, however often the guest retries it', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: 'assets/logo.png', reason: 'unreadable' })
      emitFailure({ grantId: GRANT_ID, relativePath: 'assets/logo.png', reason: 'unreadable' })
    })

    expect(container.textContent).toContain(
      'Orca could not read assets/logo.png from the workspace.'
    )
    expect(container.textContent).not.toContain('files in this document')
  })

  it('caps document-authored failure rows', async () => {
    await renderPreview(container, root)

    await act(async () => {
      for (let index = 0; index < 75; index += 1) {
        emitFailure({
          grantId: GRANT_ID,
          relativePath: `assets/missing-${index}.png`,
          reason: 'unreadable'
        })
      }
    })

    expect(container.textContent).toContain('50 files in this document could not be loaded.')
    expect(container.textContent).not.toContain('75 files in this document could not be loaded.')
  })

  it('asks before reading a directory outside the document folder', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'assets/app.js',
        reason: 'authorization-required'
      })
    })

    expect(container.textContent).toContain('This preview wants to read files in assets.')
    expect(container.textContent).toContain('Dismiss')
    expect(container.textContent).toContain('Allow folder')
    expect(grantRuntime.authorizations).toEqual([])
  })

  it('names the full workspace root when the document asks for a root file', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({
        grantId: GRANT_ID,
        relativePath: '.env',
        reason: 'authorization-required'
      })
    })

    expect(container.textContent).toContain('This preview wants to read files in /repo.')
  })

  it('authorizes only after Allow folder and reloads the guest', async () => {
    await renderPreview(container, root)
    const reload = vi.fn()
    Object.assign(container.querySelector('webview')!, { reload })

    await act(async () => {
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'assets/app.js',
        reason: 'authorization-required'
      })
    })
    const allowButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Allow folder'
    )

    await act(async () => {
      allowButton?.click()
    })

    expect(grantRuntime.authorizations).toEqual([
      { grantId: GRANT_ID, relativePath: 'assets/app.js' }
    ])
    expect(reload).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('This preview wants to read files in assets.')
  })

  it('batches folders blocked in one load into a single decision', async () => {
    await renderPreview(container, root)
    const reload = vi.fn()
    Object.assign(container.querySelector('webview')!, { reload })

    await act(async () => {
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'assets/app.js',
        reason: 'authorization-required'
      })
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'assets/theme.css',
        reason: 'authorization-required'
      })
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'data/rows.json',
        reason: 'authorization-required'
      })
    })

    expect(container.textContent).toContain('This preview wants to read files in assets and data.')
    const allowButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Allow 2 folders'
    )
    expect(allowButton).toBeDefined()

    await act(async () => {
      allowButton?.click()
    })

    // One decision grants exactly the named set, then one reload picks it all up.
    expect(grantRuntime.authorizations).toEqual([
      { grantId: GRANT_ID, relativePath: 'assets/app.js' },
      { grantId: GRANT_ID, relativePath: 'data/rows.json' }
    ])
    expect(reload).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('This preview wants to read files in')
  })

  it('dismisses every folder the banner named, not just the first', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'assets/app.js',
        reason: 'authorization-required'
      })
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'data/rows.json',
        reason: 'authorization-required'
      })
    })
    const dismissButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Dismiss'
    )
    await act(async () => {
      dismissButton?.click()
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'data/other.json',
        reason: 'authorization-required'
      })
    })

    expect(container.textContent).not.toContain('This preview wants to read files in')
    expect(grantRuntime.authorizations).toEqual([])
  })

  it('does not reprompt for a dismissed directory during the grant lifetime', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'assets/app.js',
        reason: 'authorization-required'
      })
    })
    const dismissButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Dismiss'
    )
    await act(async () => {
      dismissButton?.click()
      emitFailure({
        grantId: GRANT_ID,
        relativePath: 'assets/theme.css',
        reason: 'authorization-required'
      })
    })

    expect(container.textContent).not.toContain('This preview wants to read files in assets.')
    expect(grantRuntime.authorizations).toEqual([])
  })

  // Why: nothing rendered, so the notice strip would be a footnote on a blank page.
  it('replaces the asset notice with the failure panel when the document itself fails', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: 'assets/logo.png', reason: 'unreadable' })
      emitFailure({ grantId: GRANT_ID, reason: 'download-blocked' })
      emitFailure({ grantId: GRANT_ID, relativePath: ENTRY_RELATIVE_PATH, reason: 'too-large' })
    })

    expect(container.textContent).toContain('Preview unavailable')
    expect(container.textContent).not.toContain('assets/logo.png')
    expect(container.textContent).not.toContain('Downloads are disabled in document previews.')
  })

  // Why the notice exists at all: the preview partition cancels the download before it starts, so
  // without this a pressed download button produces nothing the reader can tell from a bug.
  it('tells the reader a refused download was refused, without taking the document away', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, reason: 'download-blocked' })
    })

    expect(container.textContent).toContain('Downloads are disabled in document previews.')
    expect(container.textContent).not.toContain('Preview unavailable')
    expect(container.querySelector('webview')).not.toBeNull()
  })

  // Why: the document chooses when and how often to ask, so a per-attempt row would let a page
  // scroll Orca's own chrome off the screen.
  it('shows one refusal notice however often the document asks', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, reason: 'download-blocked' })
      emitFailure({ grantId: GRANT_ID, reason: 'download-blocked' })
      emitFailure({ grantId: GRANT_ID, reason: 'download-blocked' })
    })

    const notices = container.querySelectorAll('[role="status"]')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.textContent).toContain('Downloads are disabled in document previews.')
  })

  it('keeps a refused download and a failed asset as separate sentences', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, reason: 'download-blocked' })
      emitFailure({ grantId: GRANT_ID, relativePath: 'assets/logo.png', reason: 'unreadable' })
    })

    expect(container.textContent).toContain('Downloads are disabled in document previews.')
    expect(container.textContent).toContain(
      'Orca could not read assets/logo.png from the workspace.'
    )
    // The asset count describes files the document could not load; a refusal is not one of them.
    expect(container.textContent).not.toContain('2 files in this document')
  })

  it('ignores a refusal reported for another preview tab', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: 'b'.repeat(32), reason: 'download-blocked' })
    })

    expect(container.textContent).not.toContain('Downloads are disabled in document previews.')
  })

  it('falls back to the read failure for any other unreadable document', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: ENTRY_RELATIVE_PATH, reason: 'unreadable' })
    })

    expect(container.textContent).toContain('Orca could not read this file from the workspace.')
  })

  it('ignores a failure minted for another preview tab', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({
        grantId: 'b'.repeat(32),
        relativePath: ENTRY_RELATIVE_PATH,
        reason: 'too-large'
      })
    })

    expect(container.textContent).not.toContain('Preview unavailable')
  })

  // Why: a grant is pinned to the owner ids it was minted with, so after a pairing or SSH
  // reconnect reloading the guest would just refetch the same failure forever.
  it('re-mints the grant when reload is pressed from a failure', async () => {
    await renderPreview(container, root)
    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: ENTRY_RELATIVE_PATH, reason: 'unreadable' })
    })
    expect(grantRuntime.mints).toBe(1)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Reload preview"]')?.click()
    })

    expect(grantRuntime.released).toEqual(['preview-1'])
    expect(grantRuntime.mints).toBe(2)
    expect(container.querySelector('webview')?.getAttribute('src')).toContain(REMINTED_GRANT_ID)
    expect(container.textContent).not.toContain('Preview unavailable')
  })

  it('reloads the guest in place when the document is rendering fine', async () => {
    await renderPreview(container, root)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Reload preview"]')?.click()
    })

    expect(grantRuntime.released).toEqual([])
    expect(grantRuntime.mints).toBe(1)
  })

  it('unsubscribes on unmount so a late failure cannot touch a torn-down preview', async () => {
    await renderPreview(container, root)
    expect(failureListeners).toHaveLength(1)

    await act(async () => {
      root.unmount()
      mounted = false
    })

    expect(failureListeners).toHaveLength(0)
  })
})
