// @vitest-environment happy-dom
// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { TerminalContrastSetting } from './TerminalContrastSetting'

vi.mock('../../section-layout/SearchableSetting', () => ({
  SearchableSetting: ({ children }) => children
}))
afterEach(cleanup)

function mount(initial: number | undefined = undefined): ReturnType<typeof vi.fn> {
  const persist = vi.fn()
  function Harness(): React.JSX.Element {
    const [settings, setSettings] = useState({
      terminalMinimumContrastRatio: initial
    } as GlobalSettings)
    return (
      <TerminalContrastSetting
        settings={settings}
        updateSettings={(patch) => {
          persist(patch)
          setSettings((previous) => ({ ...previous, ...patch }))
        }}
      />
    )
  }
  render(<Harness />)
  return persist
}

describe('terminal contrast modes', () => {
  it('restores the custom target when toggling through off and automatic', () => {
    const persist = mount(7)
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Automatic' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    expect(persist).toHaveBeenLastCalledWith({ terminalMinimumContrastRatio: 7 })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7')
  })
})
