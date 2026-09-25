// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { BrowserGrabPayload, BrowserGrabResult } from '../../../../shared/browser-grab-types'
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  setGrabMode: vi.fn(),
  awaitGrabSelection: vi.fn(),
  captureSelectionScreenshot: vi.fn()
}))
vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))

type PaneProps = ComponentProps<typeof ClientHostedBrowserPagePane>
const placement = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}
const payload: BrowserGrabPayload = {
  page: {
    sanitizedUrl: 'https://example.internal/app',
    title: 'App',
    viewportWidth: 800,
    viewportHeight: 600,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 2,
    capturedAt: '2026-09-25T00:00:00.000Z'
  },
  target: {
    tagName: 'div',
    selector: 'div.rules',
    textSnippet: 'The seven rules',
    htmlSnippet: '<div class="rules">The seven rules</div>',
    attributes: { class: 'rules' },
    accessibility: { role: null, accessibleName: null, ariaLabel: null, ariaLabelledBy: null },
    rectViewport: { x: 10, y: 20, width: 200, height: 40 },
    rectPage: { x: 10, y: 20, width: 200, height: 40 },
    computedStyles: {
      display: 'block',
      position: 'static',
      width: '200px',
      height: '40px',
      margin: '0px',
      padding: '0px',
      color: 'rgb(0, 0, 0)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      border: '0px none',
      borderRadius: '0px',
      fontFamily: 'Inter',
      fontSize: '16px',
      fontWeight: '400',
      lineHeight: '24px',
      textAlign: 'start',
      zIndex: 'auto'
    }
  },
  nearbyText: [],
  ancestorPath: [],
  screenshot: null
}

beforeEach(() => {
  mocks.setGrabMode.mockResolvedValue({ ok: true })
  mocks.captureSelectionScreenshot.mockResolvedValue({ ok: false })
  installClientHostedPaneApi({
    browser: {
      setGrabMode: mocks.setGrabMode,
      awaitGrabSelection: mocks.awaitGrabSelection,
      captureSelectionScreenshot: mocks.captureSelectionScreenshot
    }
  })
  useAppStore.setState({ browserCertificateFailuresByPageId: {}, browserAnnotationsByPageId: {} })
  window.localStorage.setItem('orca.browser.markup-draw-hint-seen', 'true')
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

const basePage: PaneProps['browserTab'] = {
  id: 'page-a',
  workspaceId: 'workspace-a',
  worktreeId: 'folder-a',
  url: 'https://example.internal/app',
  title: 'App',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 1
}

function renderPane(overrides: Partial<PaneProps> = {}) {
  const webview = Object.assign(document.createElement('webview'), {
    getURL: () => 'https://example.internal/app',
    getTitle: () => 'App',
    isLoading: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    getWebContentsId: () => 42,
    getZoomLevel: () => 0,
    focus: vi.fn(),
    blur: vi.fn()
  })
  mocks.attach.mockReturnValue({ webview, detach: vi.fn(), nextMetadataRevision: () => 1 })
  const props: PaneProps = {
    browserTab: basePage,
    workspaceId: 'workspace-a',
    runtimeEnvironmentId: 'environment-a',
    worktreeId: 'folder-a',
    placement,
    isActive: true,
    chromeShortcutScope: 'focused',
    onUpdatePageState: vi.fn(),
    onSetUrl: vi.fn(),
    ...overrides
  }
  render(
    <TooltipProvider>
      <ClientHostedBrowserPagePane {...props} />
    </TooltipProvider>
  )
  return { webview }
}

function toolButton(name: string): HTMLButtonElement {
  const button = screen.getByRole('button', { name })
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`${name} is not a button element`)
  }
  return button
}
const annotateButton = (): HTMLButtonElement => toolButton('Annotate page element')

describe('client-hosted page annotations', () => {
  it('offers Grab and Annotate on a placed page', () => {
    renderPane()
    expect(toolButton('Grab page element').disabled).toBe(false)
    expect(annotateButton().disabled).toBe(false)
  })

  it.each(['pending', 'inactive'])('disables the element tools for a %s pane', (state) => {
    renderPane(state === 'pending' ? { placement: null } : { isActive: false })
    expect(annotateButton().disabled).toBe(true)
    fireEvent.click(annotateButton())
    expect(mocks.setGrabMode).not.toHaveBeenCalled()
  })

  it('arms the picker on the local guest and stores the annotation under the page', async () => {
    let resolveSelection!: (result: BrowserGrabResult) => void
    mocks.awaitGrabSelection.mockImplementation(
      ({ opId }: { opId: string }) =>
        new Promise<BrowserGrabResult>((resolve) => {
          resolveSelection = (result) => resolve({ ...result, opId })
        })
    )
    renderPane()

    fireEvent.click(annotateButton())
    // Why the page id: main resolves it to the client-hosted guest it registered for this page.
    await waitFor(() =>
      expect(mocks.setGrabMode).toHaveBeenCalledWith({ browserPageId: 'page-a', enabled: true })
    )
    await waitFor(() => expect(mocks.awaitGrabSelection).toHaveBeenCalled())

    await act(async () => resolveSelection({ opId: '', kind: 'selected', payload }))
    const comment = await screen.findByPlaceholderText(
      'Describe what the agent should change here...'
    )
    fireEvent.change(comment, { target: { value: 'Tighten the spacing' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))

    await waitFor(() =>
      expect(useAppStore.getState().browserAnnotationsByPageId['page-a']).toHaveLength(1)
    )
    expect(useAppStore.getState().browserAnnotationsByPageId['page-a'][0].comment).toBe(
      'Tighten the spacing'
    )
  })

  it('clears annotations when the guest starts a new load', async () => {
    const { webview } = renderPane()
    act(() => {
      useAppStore.setState({
        browserAnnotationsByPageId: {
          'page-a': [
            {
              id: 'annotation-1',
              browserPageId: 'page-a',
              comment: 'stale',
              intent: 'change',
              priority: 'suggestion',
              createdAt: '2026-09-25T00:00:00.000Z',
              payload: { ...payload, screenshot: null }
            }
          ]
        }
      })
    })

    fireEvent(webview, new Event('did-start-loading'))

    await waitFor(() =>
      expect(useAppStore.getState().browserAnnotationsByPageId['page-a']).toBeUndefined()
    )
  })
})
