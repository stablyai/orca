// @vitest-environment happy-dom
// Entry failures arrive out-of-band; unsupported formats are subresource failures and must not replace a rendered document.
import { act } from 'react'
import type * as WebviewRegistryModule from '../host-guest/webview-registry'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DocPreviewFailure } from '../../../../../shared/doc-preview-scheme'

const confirmExternalLink = async (): Promise<boolean> => false

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
  ensureDocPreviewGrant: (_previewId: string, location: unknown) => {
    grantRuntime.mints += 1
    // Why a fresh id per mint: a re-mint after a reconnect must bind the guest to the new grant.
    const grantId = grantRuntime.mints === 1 ? GRANT_ID : REMINTED_GRANT_ID
    return Promise.resolve({
      grantId,
      url: `orca-preview://${grantId}/${ENTRY_RELATIVE_PATH}`,
      location
    })
  },
  releaseDocPreviewGrant: (previewId: string) => {
    grantRuntime.released.push(previewId)
  }
}))

vi.mock('@/components/browser-pane/host-guest/webview-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof WebviewRegistryModule>()),
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
  recordWorkspaceDocVisit: () => undefined,
  workspaceDocHistory: [],
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
      <ConfirmationDialogContext.Provider value={confirmExternalLink}>
        <TooltipProvider>
          <HtmlDocPreview
            previewId="preview-1"
            browserWorkspaceId="browser-1"
            filePath="/repo/docs/doc.html"
            relativePath="docs/doc.html"
            worktreeId="wt-1"
          />
        </TooltipProvider>
      </ConfirmationDialogContext.Provider>
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

  // An asset refusal must leave the usable document visible.
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

  // The preview partition cancels downloads before start; a notice is the reader’s only response.
  it('tells the reader a refused download was refused, without taking the document away', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, reason: 'download-blocked' })
    })

    expect(container.textContent).toContain('Downloads are disabled in document previews.')
    expect(container.textContent).not.toContain('Preview unavailable')
    expect(container.querySelector('webview')).not.toBeNull()
  })

  // Deduplicate page-controlled refusals so repeated requests cannot fill Orca’s chrome.
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

  // Reconnect changes owner IDs; reloading the old pinned grant would repeat its failure.
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
