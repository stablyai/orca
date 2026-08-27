import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  openBrowserProfileTabInActiveWorkspace: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/components/browser-pane/describe-page/live-browser-url-registry', () => ({
  rememberLiveBrowserUrl: vi.fn()
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({ getRuntimeEnvironmentIdForWorktree: () => null }))
vi.mock('./browser-automation-bootstrap-lease', () => ({
  acquireBrowserAutomationBootstrapLease: vi.fn()
}))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      openBrowserProfileTabInActiveWorkspace: mocks.openBrowserProfileTabInActiveWorkspace,
      remoteBrowserPageHandlesByPageId: {}
    })
  }
}))

import { registerBrowserStateIpcBridge } from './browser-state-ipc-bridge'

/** Every channel the bridge subscribes to, stubbed; only the preview link one is exercised here. */
function installBridge(): (payload: { url: string }) => void {
  let externalLinkHandler: ((payload: { url: string }) => void) | null = null
  const noopSubscribe = (): (() => void) => () => {}
  vi.stubGlobal('window', {
    api: {
      ui: { onFullscreenChanged: noopSubscribe },
      browser: new Proxy(
        {},
        {
          get: () => (): (() => void) => () => {}
        }
      ),
      docPreview: {
        onExternalLink: (callback: (payload: { url: string }) => void): (() => void) => {
          externalLinkHandler = callback
          return () => {}
        }
      }
    }
  })
  registerBrowserStateIpcBridge([], () => false)
  if (!externalLinkHandler) {
    throw new Error('bridge did not subscribe to the doc preview external link channel')
  }
  return externalLinkHandler
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.openBrowserProfileTabInActiveWorkspace.mockResolvedValue(true)
})

describe('doc preview external links', () => {
  it('routes an external link into a browser tab', async () => {
    installBridge()({ url: 'https://example.com/docs' })
    await vi.waitFor(() =>
      expect(mocks.openBrowserProfileTabInActiveWorkspace).toHaveBeenCalledWith(
        'https://example.com/docs',
        null
      )
    )

    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  // Why: the click already left the preview behind, so a refused tab is a dead end unless it says
  // so — the store reports that refusal by returning false, not by throwing.
  it('surfaces a refused tab instead of dropping the click', async () => {
    mocks.openBrowserProfileTabInActiveWorkspace.mockResolvedValue(false)

    installBridge()({ url: 'https://example.com/docs' })

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
  })

  // Why the same sentence for a rejection: to the reader a tab that threw and a tab that was refused
  // are the same dead end, and an unhandled rejection would leave the press with no answer at all.
  it('surfaces a tab that failed rather than refused', async () => {
    mocks.openBrowserProfileTabInActiveWorkspace.mockRejectedValue(new Error('no workspace'))

    installBridge()({ url: 'https://example.com/docs' })

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
  })
})
