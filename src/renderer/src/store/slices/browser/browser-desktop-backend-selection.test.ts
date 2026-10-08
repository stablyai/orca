import { describe, expect, it } from 'vitest'
import { selectNewDesktopBrowserBackend } from './browser-desktop-backend-selection'

const localPage = {
  requested: 'owned-view',
  desktopAvailable: true,
  connectionId: null,
  runtimeEnvironmentId: null,
  workspaceDocument: false,
  routedPartition: false
} as const

describe('new desktop browser backend selection', () => {
  it('selects the owned view for new local pages and preserves explicit webviews', () => {
    expect(selectNewDesktopBrowserBackend({ ...localPage, requested: undefined })).toBe(
      'owned-view'
    )
    expect(selectNewDesktopBrowserBackend({ ...localPage, requested: 'webview' })).toBe('webview')
    expect(selectNewDesktopBrowserBackend(localPage)).toBe('owned-view')
  })

  it.each([
    { desktopAvailable: false },
    { connectionId: undefined },
    { connectionId: 'ssh-target' },
    { runtimeEnvironmentId: 'remote-runtime' },
    { workspaceDocument: true },
    { routedPartition: true }
  ])('rejects an ineligible explicit request: %j', (changes) => {
    expect(
      selectNewDesktopBrowserBackend({ ...localPage, ...changes, requested: undefined })
    ).toBeUndefined()
    expect(() => selectNewDesktopBrowserBackend({ ...localPage, ...changes })).toThrow(
      'resolved local desktop URL page'
    )
  })

  it.each([
    { desktopAvailable: false },
    { connectionId: undefined },
    { connectionId: 'ssh-target' },
    { runtimeEnvironmentId: 'remote-runtime' },
    { workspaceDocument: true },
    { routedPartition: true }
  ])('keeps an explicit webview for every owned-view-ineligible page: %j', (changes) => {
    expect(selectNewDesktopBrowserBackend({ ...localPage, ...changes, requested: 'webview' })).toBe(
      'webview'
    )
  })
})
