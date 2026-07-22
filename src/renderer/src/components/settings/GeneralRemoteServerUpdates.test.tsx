import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GeneralRemoteServerUpdates } from './GeneralRemoteServerUpdates'

const storeMock = vi.hoisted(() => ({
  state: {
    settingsSearchQuery: '',
    remoteServerUpdates: new Map([
      [
        'server-a',
        {
          environmentId: 'server-a',
          name: 'Test server A',
          phase: 'current'
        }
      ]
    ]),
    remoteServerUpdatesRunning: false,
    refreshRemoteServerUpdates: vi.fn(),
    setRemoteServerUpdateDialogOpen: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state)
}))

describe('GeneralRemoteServerUpdates', () => {
  it('matches the local update check action treatment', () => {
    const markup = renderToStaticMarkup(<GeneralRemoteServerUpdates />)

    expect(markup).toContain('Check for Server Updates')
    expect(markup).toContain('lucide-refresh-cw')
    expect(markup).not.toContain('lucide-download')
    expect(markup).toContain('1 paired server · 1 up to date')
  })
})
