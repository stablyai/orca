// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    remoteServerUpdatesChecking: false,
    remoteServerUpdatesRunning: false,
    refreshRemoteServerUpdates: vi.fn(),
    setRemoteServerUpdateDialogOpen: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state)
}))

describe('GeneralRemoteServerUpdates', () => {
  beforeEach(() => {
    storeMock.state.refreshRemoteServerUpdates.mockReset()
    storeMock.state.setRemoteServerUpdateDialogOpen.mockReset()
  })

  it('matches the local update check action and forwards modifier options', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<GeneralRemoteServerUpdates />))
    storeMock.state.refreshRemoteServerUpdates.mockClear()

    const button = container.querySelector('button')
    expect(button?.textContent).toContain('Check for Server Updates')
    expect(button?.querySelector('svg.lucide-refresh-cw')).not.toBeNull()
    expect(button?.querySelector('svg.lucide-download')).toBeNull()
    expect(container.textContent).toContain('1 paired server · 1 up to date')

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    })

    expect(storeMock.state.setRemoteServerUpdateDialogOpen).toHaveBeenCalledWith(true)
    expect(storeMock.state.refreshRemoteServerUpdates).toHaveBeenCalledWith({
      includePrerelease: true,
      includePerfPrerelease: false
    })
    await act(async () => root.unmount())
  })
})
