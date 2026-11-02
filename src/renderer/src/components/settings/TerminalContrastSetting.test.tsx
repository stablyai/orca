// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TerminalContrastSetting } from './TerminalContrastSetting'

vi.mock('./SearchableSetting', () => ({ SearchableSetting: ({ children }) => children }))
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
  it('lets users turn correction off and restore automatic without editing a number', () => {
    const persist = mount()
    expect(screen.getByRole('radio', { name: 'Automatic' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.queryByRole('spinbutton')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(persist).toHaveBeenLastCalledWith({ terminalMinimumContrastRatio: 1 })
    expect(screen.queryByRole('spinbutton')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Automatic' }))
    expect(persist).toHaveBeenLastCalledWith({ terminalMinimumContrastRatio: undefined })
  })

  it('restores the custom target when toggling through off and automatic', () => {
    const persist = mount(7)
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Automatic' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    expect(persist).toHaveBeenLastCalledWith({ terminalMinimumContrastRatio: 7 })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7')
  })

  it('starts custom at a usable target and bounds precise input', () => {
    const persist = mount()
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    expect(persist).toHaveBeenLastCalledWith({ terminalMinimumContrastRatio: 4.5 })
    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)
    expect(persist).toHaveBeenLastCalledWith({ terminalMinimumContrastRatio: 21 })
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)
    expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true')
  })
})
