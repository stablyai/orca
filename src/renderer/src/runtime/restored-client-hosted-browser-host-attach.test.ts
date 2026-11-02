import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureBrowserClientHostsForRestoredPages,
  resetRestoredBrowserClientHostAttachForTests
} from './restored-client-hosted-browser-host-attach'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

type Placement = { kind: 'client'; browserHostClientId: string } | { kind: 'server' }

const CLIENT_PLACEMENT: Placement = { kind: 'client', browserHostClientId: 'browser-host-1' }

const prepareBrowserClientHostPlacement = vi.fn(
  async (_args: { selector: string }): Promise<Placement> => CLIENT_PLACEMENT
)

function handles(
  entries: Record<string, { environmentId: string; clientHosted?: true }>
): Parameters<typeof ensureBrowserClientHostsForRestoredPages>[0] {
  return {
    remoteBrowserPageHandlesByPageId: Object.fromEntries(
      Object.entries(entries).map(([pageId, entry]) => [
        pageId,
        {
          environmentId: entry.environmentId,
          remotePageId: `remote-${pageId}`,
          restoredFromSession: true as const,
          ...(entry.clientHosted ? { restoredClientHosted: true as const } : {})
        }
      ])
    )
  }
}

function preparedEnvironmentIds(): string[] {
  return prepareBrowserClientHostPlacement.mock.calls.map((call) => call[0].selector)
}

describe('ensureBrowserClientHostsForRestoredPages', () => {
  beforeEach(() => {
    resetRestoredBrowserClientHostAttachForTests()
    prepareBrowserClientHostPlacement.mockClear()
    prepareBrowserClientHostPlacement.mockResolvedValue(CLIENT_PLACEMENT)
    stubRuntimeEnvironmentBridge({ prepareBrowserClientHostPlacement })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not stack a second preparation on top of one still in flight', async () => {
    let settle = (): void => {}
    prepareBrowserClientHostPlacement.mockImplementation(
      () => new Promise((resolve) => (settle = () => resolve(CLIENT_PLACEMENT)))
    )
    const restored = handles({ 'page-1': { environmentId: 'env-1', clientHosted: true } })

    const first = ensureBrowserClientHostsForRestoredPages(restored)
    await ensureBrowserClientHostsForRestoredPages(restored)
    settle()
    await first

    expect(preparedEnvironmentIds()).toEqual(['env-1'])
  })

  // Hydration before reachability must remain retryable or restored tabs never recover.
  it('retries an environment whose preparation failed when it is asked again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    prepareBrowserClientHostPlacement.mockRejectedValueOnce(new Error('runtime_unreachable'))
    const restored = handles({ 'page-1': { environmentId: 'env-1', clientHosted: true } })

    await ensureBrowserClientHostsForRestoredPages(restored)
    await ensureBrowserClientHostsForRestoredPages(restored)

    expect(preparedEnvironmentIds()).toEqual(['env-1', 'env-1'])
    warn.mockRestore()
  })
})
