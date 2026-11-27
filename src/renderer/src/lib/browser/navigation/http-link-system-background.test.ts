import { beforeEach, describe, expect, it, vi } from 'vitest'

const openUrl = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../workspace/workspace-browser-open-failure-toast', () => ({
  showBrowserOpenFailure: vi.fn()
}))

import { openHttpLink, registerHttpLinkStoreAccessor } from './http-link-routing'
import { openRoutedHttpLink } from './http-link-destinations'

describe('system browser background link opening', () => {
  beforeEach(() => {
    openUrl.mockClear()
    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInApp: false },
      setActiveWorktree: vi.fn(),
      createBrowserTab: vi.fn(),
      repos: [],
      projects: [],
      worktreesByRepo: {}
    }))
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          shell: { openUrl }
        }
      }
    })
  })

  it('omits options when opening a link in the foreground', () => {
    const destination = openHttpLink('https://example.com/a', {
      forceSystemBrowser: true,
      sourceOwner: { kind: 'local' }
    })

    expect(destination).toBe('system-browser')
    expect(openUrl).toHaveBeenCalledWith('https://example.com/a')
  })

  it('passes { background: true } when backgroundSystemBrowser is requested', () => {
    const destination = openHttpLink('https://example.com/b', {
      forceSystemBrowser: true,
      backgroundSystemBrowser: true,
      sourceOwner: { kind: 'local' }
    })

    expect(destination).toBe('system-browser')
    expect(openUrl).toHaveBeenCalledWith('https://example.com/b', { background: true })
  })

  it('forwards backgroundSystemBrowser through openRoutedHttpLink', () => {
    openRoutedHttpLink('https://example.com/c', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' },
      forceDestination: 'system',
      backgroundSystemBrowser: true
    })

    expect(openUrl).toHaveBeenCalledWith('https://example.com/c', { background: true })
  })
})
