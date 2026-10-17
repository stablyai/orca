// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserTerminalLinkActionsSetting } from './BrowserTerminalLinkActionsSetting'

afterEach(cleanup)

function plainClickOption(label: string): HTMLElement {
  const group = screen.getByRole('radiogroup', { name: 'Plain click URL behavior' })
  return within(group).getByRole('radio', { name: label })
}

describe('BrowserTerminalLinkActionsSetting', () => {
  it('re-enables the legacy popover flag when Actions is chosen', () => {
    const updateSettings = vi.fn()
    render(
      <BrowserTerminalLinkActionsSetting
        settings={{ terminalLinkActionPopoverEnabled: false, terminalLinkClickBehavior: 'actions' }}
        isMac={false}
        updateSettings={updateSettings}
      />
    )
    expect(plainClickOption('Leave to terminal').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(plainClickOption('Actions'))

    expect(updateSettings).toHaveBeenCalledWith({
      terminalLinkClickBehavior: 'actions',
      terminalLinkActionPopoverEnabled: true
    })
  })

  it('does not touch the legacy flag for the other choices', () => {
    const updateSettings = vi.fn()
    render(
      <BrowserTerminalLinkActionsSetting
        settings={{ terminalLinkActionPopoverEnabled: false, terminalLinkClickBehavior: 'actions' }}
        isMac={false}
        updateSettings={updateSettings}
      />
    )
    fireEvent.click(plainClickOption('Open URL'))
    expect(updateSettings).toHaveBeenCalledWith({ terminalLinkClickBehavior: 'open' })
  })
})
