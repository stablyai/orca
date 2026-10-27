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

  // Restored pages need explicit lazy-host startup; without attach the runtime cannot recover retained pages.
  it('starts the browser client host once for an environment with restored client-hosted rows', async () => {
    await ensureBrowserClientHostsForRestoredPages(
      handles({
        'page-1': { environmentId: 'env-1', clientHosted: true },
        'page-2': { environmentId: 'env-1', clientHosted: true }
      })
    )

    expect(preparedEnvironmentIds()).toEqual(['env-1'])
  })

  it('starts a host for every environment that has restored client-hosted rows', async () => {
    await ensureBrowserClientHostsForRestoredPages(
      handles({
        'page-1': { environmentId: 'env-1', clientHosted: true },
        'page-2': { environmentId: 'env-2', clientHosted: true }
      })
    )

    expect(preparedEnvironmentIds().sort()).toEqual(['env-1', 'env-2'])
  })

  // Server-hosted pages need no desktop hosting duty.
  it('starts no host for restored rows the server hosts', async () => {
    await ensureBrowserClientHostsForRestoredPages(
      handles({ 'page-1': { environmentId: 'env-1' } })
    )

    expect(preparedEnvironmentIds()).toEqual([])
  })

  // Adoption spends restored markers; environments without them must stop retries.
  it('starts no host once adoption has spent the restored markers', async () => {
    await ensureBrowserClientHostsForRestoredPages(
      handles({ 'page-1': { environmentId: 'env-1', clientHosted: true } })
    )
    prepareBrowserClientHostPlacement.mockClear()

    await ensureBrowserClientHostsForRestoredPages(
      handles({ 'page-1': { environmentId: 'env-1' } })
    )

    expect(preparedEnvironmentIds()).toEqual([])
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

  // Preparation failure must not abort startup hydration into degraded no-save mode.
  it('swallows a failed preparation instead of rejecting into hydration', async () => {
    prepareBrowserClientHostPlacement.mockRejectedValue(new Error('runtime_manually_disconnected'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const restored = handles({ 'page-1': { environmentId: 'env-1', clientHosted: true } })

    await expect(ensureBrowserClientHostsForRestoredPages(restored)).resolves.toBeUndefined()

    expect(preparedEnvironmentIds()).toEqual(['env-1'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // Unanswered probes fall back to server placement without throwing; this diagnostic exposes failed relaunch recovery.
  it('warns when preparation answers server placement for pages this desktop was hosting', async () => {
    prepareBrowserClientHostPlacement.mockResolvedValue({ kind: 'server' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await ensureBrowserClientHostsForRestoredPages(
      handles({ 'page-1': { environmentId: 'env-1', clientHosted: true } })
    )

    expect(warn).toHaveBeenCalledWith(expect.any(String), 'server', 'for', 'env-1')
    warn.mockRestore()
  })

  // Status can observe reachability before browser handles exist.
  it('starts no host for a state with no handle map yet', async () => {
    await expect(ensureBrowserClientHostsForRestoredPages({})).resolves.toBeUndefined()

    expect(preparedEnvironmentIds()).toEqual([])
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
