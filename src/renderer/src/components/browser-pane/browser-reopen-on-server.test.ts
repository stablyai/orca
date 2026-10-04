import { describe, expect, it, vi } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'

const mocks = vi.hoisted(() => ({
  createWebRuntimeSessionBrowserTab: vi.fn(async (_args: Record<string, unknown>) => true)
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab
}))

import {
  reopenBrowserPageOnServer,
  resolveBrowserReopenOnServerUrl
} from './browser-reopen-on-server'

describe('resolveBrowserReopenOnServerUrl', () => {
  it('keeps a committed web URL', () => {
    expect(resolveBrowserReopenOnServerUrl('https://example.com/app')).toBe(
      'https://example.com/app'
    )
  })

  it('reopens blank rather than replaying something the new engine cannot restore', () => {
    expect(resolveBrowserReopenOnServerUrl(ORCA_BROWSER_BLANK_URL)).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl('about:blank')).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl('file:///etc/hosts')).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl('')).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl(null)).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl(undefined)).toBeUndefined()
  })
})

describe('reopenBrowserPageOnServer', () => {
  it('creates a new server-placed page at the last committed URL', async () => {
    mocks.createWebRuntimeSessionBrowserTab.mockClear()

    await expect(
      reopenBrowserPageOnServer({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        lastCommittedUrl: 'https://example.com/app'
      })
    ).resolves.toBe(true)

    expect(mocks.createWebRuntimeSessionBrowserTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'env-1',
      url: 'https://example.com/app',
      placementPreference: 'server',
      focusOnCreate: true
    })
  })
})
