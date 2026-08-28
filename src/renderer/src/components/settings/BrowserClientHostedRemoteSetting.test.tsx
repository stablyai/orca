// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { BrowserClientHostedRemoteSetting } from './BrowserClientHostedRemoteSetting'
import { getBrowserPaneSearchEntries } from './browser-search'
import { getBrowserClientHostedRemoteTitle } from './browser-client-hosted-remote-copy'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

function renderSetting(
  settings: Pick<GlobalSettings, 'browserClientHostedRemoteEnabled'>,
  updateSettings: (updates: Partial<GlobalSettings>) => void = vi.fn()
): void {
  render(
    <TooltipProvider>
      <BrowserClientHostedRemoteSetting settings={settings} updateSettings={updateSettings} />
    </TooltipProvider>
  )
}

describe('BrowserClientHostedRemoteSetting', () => {
  afterEach(() => {
    cleanup()
  })

  it('defaults to this-device rendering when the profile predates the flag', () => {
    renderSetting({})
    expect(screen.getByRole('radio', { name: 'This device' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.getByText(/new pages only/i)).toBeTruthy()
  })

  it('reads an explicit opt-out as server-streamed rendering', () => {
    renderSetting({ browserClientHostedRemoteEnabled: false })
    expect(
      screen.getByRole('radio', { name: 'Server (streamed)' }).getAttribute('aria-checked')
    ).toBe('true')
  })

  it('writes the chosen placement through the global settings path', () => {
    const updateSettings = vi.fn()
    renderSetting({ browserClientHostedRemoteEnabled: true }, updateSettings)
    fireEvent.click(screen.getByRole('radio', { name: 'Server (streamed)' }))
    expect(updateSettings).toHaveBeenLastCalledWith({ browserClientHostedRemoteEnabled: false })
    fireEvent.click(screen.getByRole('radio', { name: 'This device' }))
    expect(updateSettings).toHaveBeenLastCalledWith({ browserClientHostedRemoteEnabled: true })
  })

  it('is findable from settings search by its own title', () => {
    const entry = getBrowserPaneSearchEntries({ isMac: false }).find(
      (candidate) => candidate.title === getBrowserClientHostedRemoteTitle()
    )

    expect(entry?.keywords).toContain('placement')
    expect(entry?.description).toContain('new pages only')
  })
})
