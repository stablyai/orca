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
})
