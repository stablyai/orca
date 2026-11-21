// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { BrowserPage } from '../../../shared/browser/workspaces/browser-workspace-types'
import { connectorReturnUrl, followProviderReturn } from './browser-return-watch'

const page = (url: string): BrowserPage => ({
  id: 'p1',
  workspaceId: 'ws',
  worktreeId: 'wt',
  url,
  title: '',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 1
})

afterEach(() => useAppStore.setState({ browserPagesByWorkspace: {} }))

describe('following a provider wait', () => {
  it('reads at once on a return, then every 1 s for 30 s, then every 3 s again', () => {
    let now = 0
    const check = vi.fn()
    const follow = followProviderReturn({
      returnUrl: connectorReturnUrl('linear', 'https://connector.example/linear/install'),
      check,
      now: () => now
    })
    expect(follow.delay()).toBe(3_000)

    // Orca's browser lands on the connector's return page.
    useAppStore.setState({
      browserPagesByWorkspace: {
        ws: [page('https://connector.example/linear/oauth/callback?code=c&state=s')]
      }
    })
    expect(check).toHaveBeenCalledTimes(1)
    expect(follow.delay()).toBe(1_000)
    now = 29_999
    expect(follow.delay()).toBe(1_000)
    now = 30_000
    expect(follow.delay()).toBe(3_000)

    // Coming back to Orca's window counts the same way.
    window.dispatchEvent(new Event('focus'))
    expect(check).toHaveBeenCalledTimes(2)
    expect(follow.delay(30_000)).toBe(1_000)

    follow.stop()
    window.dispatchEvent(new Event('focus'))
    expect(check).toHaveBeenCalledTimes(2)
  })
})
