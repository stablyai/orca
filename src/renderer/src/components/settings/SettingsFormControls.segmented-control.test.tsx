// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { SettingsSegmentedControl } from './SettingsFormControls'

afterEach(cleanup)

function renderControl(onChange = vi.fn()): { onChange: ReturnType<typeof vi.fn> } {
  render(
    <TooltipProvider>
      <SettingsSegmentedControl<string>
        value="stable"
        onChange={onChange}
        options={[
          { value: 'stable', label: 'Stable' },
          {
            value: 'hourly',
            label: 'Hourly',
            disabled: true,
            ariaLabel: 'Hourly (macOS and Windows only)',
            tooltip: 'Hourly builds are produced only for macOS and Windows.'
          }
        ]}
      />
    </TooltipProvider>
  )
  return { onChange }
}

describe('SettingsSegmentedControl unavailable options', () => {
  // Why: a native disabled button leaves the tab order, so keyboard users can never
  // focus it to open the tooltip explaining why the option is unavailable.
  it('marks unavailable options aria-disabled so their tooltip stays reachable', async () => {
    renderControl()

    const hourly = screen.getByRole('radio', { name: 'Hourly (macOS and Windows only)' })
    expect(hourly.hasAttribute('disabled')).toBe(false)
    expect(hourly.getAttribute('aria-disabled')).toBe('true')

    fireEvent.focus(hourly)
    expect(
      await screen.findAllByText('Hourly builds are produced only for macOS and Windows.')
    ).not.toHaveLength(0)
  })

  it('ignores clicks on unavailable options', () => {
    const { onChange } = renderControl()

    fireEvent.click(screen.getByRole('radio', { name: 'Hourly (macOS and Windows only)' }))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('radio', { name: 'Stable' }))
    expect(onChange).toHaveBeenCalledWith('stable')
  })
})
