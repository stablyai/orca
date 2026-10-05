import { describe, expect, it } from 'vitest'
import { browserPageSchema } from './workspace-session-browser-schema'

const storedPage = {
  id: 'page',
  workspaceId: 'workspace',
  worktreeId: 'folder:workspace',
  url: 'https://example.test/',
  title: 'Example',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 1
}

describe('persisted browser desktop backend', () => {
  it('does not convert historical pages without a marker', () => {
    expect(browserPageSchema.parse(storedPage)).not.toHaveProperty('desktopBackend')
  })

  it.each(['webview', 'owned-view'])('round-trips a selected %s backend', (desktopBackend) => {
    const restored = browserPageSchema.parse(
      JSON.parse(JSON.stringify({ ...storedPage, desktopBackend }))
    )
    expect(restored.desktopBackend).toBe(desktopBackend)
    expect(restored.id).toBe(storedPage.id)
  })

  it('keeps a page from a newer backend version available on the legacy backend', () => {
    const restored = browserPageSchema.parse({ ...storedPage, desktopBackend: 'future-backend' })
    expect(restored.desktopBackend).toBe('webview')
    expect(restored.url).toBe(storedPage.url)
  })

  it('does not accept a malformed backend marker', () => {
    expect(browserPageSchema.safeParse({ ...storedPage, desktopBackend: 7 }).success).toBe(false)
  })
})
