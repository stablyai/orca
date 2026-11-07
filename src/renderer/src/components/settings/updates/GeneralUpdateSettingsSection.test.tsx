// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../store'
import { TooltipProvider } from '../../ui/tooltip'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

vi.mock('./ReleaseChannelSection', () => ({
  ReleaseChannelSection: () => <div>release channel switcher</div>
}))

vi.mock('../runtime-environments/updates/GeneralRemoteServerUpdates', () => ({
  GeneralRemoteServerUpdates: () => null
}))

describe('GeneralUpdateSettingsSection release channel gesture', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsSearchQuery: '', updateStatus: { state: 'idle' } })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { updater: { getVersion: vi.fn().mockResolvedValue('1.4.250') } }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('reveals the switcher when the version line under the title is Option-clicked', async () => {
    render(
      <TooltipProvider>
        <GeneralUpdateSettingsSection />
      </TooltipProvider>
    )
    const versionLine = await screen.findByText('Current version: 1.4.250')

    expect(screen.queryByText('release channel switcher')).toBeNull()
    act(() => {
      fireEvent.click(versionLine, { altKey: true })
    })
    expect(screen.getByText('release channel switcher')).toBeTruthy()
  })
})
