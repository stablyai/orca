import { describe, expect, it, vi } from 'vitest'
import { createHarnessStoreState, loadIpcEventsHarness } from './ipc-events-test-harness'

const FAILURE = {
  browserPageId: 'page-1',
  challengeId: 'challenge-1',
  origin: 'https://selfsigned.internal',
  error: 'ERR_CERT_AUTHORITY_INVALID',
  errorCode: -202,
  canProceed: true
}

/**
 * The blanket runtime-active guard on this channel came from the streamed-only era, where a
 * connected runtime meant every browser page's state arrived through the host's tab sync. A
 * client-hosted page is a local Electron webview whose certificate challenge is raised by THIS
 * main process, so the same guard silently emptied its "Proceed Anyway" affordance.
 */
describe('browser certificate failures while a runtime environment is active', () => {
  it('stores a client-hosted page failure', async () => {
    const setBrowserPageCertificateFailure = vi.fn()
    const harness = await loadIpcEventsHarness(
      storeStateWithRuntime(setBrowserPageCertificateFailure, {
        'page-1': { environmentId: 'env-a', remotePageId: 'r-1', placement: { kind: 'client' } }
      })
    )
    harness.useIpcEvents()

    harness.certificateFailureChanged({ browserPageId: 'page-1', failure: FAILURE })

    expect(setBrowserPageCertificateFailure).toHaveBeenCalledWith('page-1', FAILURE)
  })

  it('still drops a streamed page failure, whose state the host owns', async () => {
    const setBrowserPageCertificateFailure = vi.fn()
    const harness = await loadIpcEventsHarness(
      storeStateWithRuntime(setBrowserPageCertificateFailure, {
        'page-1': { environmentId: 'env-a', remotePageId: 'r-1', placement: { kind: 'server' } }
      })
    )
    harness.useIpcEvents()

    harness.certificateFailureChanged({ browserPageId: 'page-1', failure: FAILURE })

    expect(setBrowserPageCertificateFailure).not.toHaveBeenCalled()
  })

  it('still drops a failure for a page with no remote handle at all', async () => {
    const setBrowserPageCertificateFailure = vi.fn()
    const harness = await loadIpcEventsHarness(
      storeStateWithRuntime(setBrowserPageCertificateFailure, {})
    )
    harness.useIpcEvents()

    harness.certificateFailureChanged({ browserPageId: 'page-1', failure: FAILURE })

    expect(setBrowserPageCertificateFailure).not.toHaveBeenCalled()
  })

  it('stores a local page failure when no runtime environment is active', async () => {
    const setBrowserPageCertificateFailure = vi.fn()
    const harness = await loadIpcEventsHarness(
      createHarnessStoreState({
        tabsByWorktree: {},
        setBrowserPageCertificateFailure,
        remoteBrowserPageHandlesByPageId: {}
      })
    )
    harness.useIpcEvents()

    harness.certificateFailureChanged({ browserPageId: 'page-1', failure: FAILURE })

    expect(setBrowserPageCertificateFailure).toHaveBeenCalledWith('page-1', FAILURE)
  })
})

function storeStateWithRuntime(
  setBrowserPageCertificateFailure: ReturnType<typeof vi.fn>,
  remoteBrowserPageHandlesByPageId: Record<string, unknown>
): ReturnType<typeof createHarnessStoreState> {
  return createHarnessStoreState({
    tabsByWorktree: {},
    setBrowserPageCertificateFailure,
    remoteBrowserPageHandlesByPageId,
    settings: {
      terminalFontSize: 13,
      experimentalNativeChat: false,
      openAgentTabsInChatByDefault: false,
      activeRuntimeEnvironmentId: 'env-a'
    }
  })
}
