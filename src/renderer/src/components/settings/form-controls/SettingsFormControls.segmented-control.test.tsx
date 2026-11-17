// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../ui/tooltip'
import { SettingsSegmentedControl } from './SettingsFormControls'

afterEach(cleanup)

describe('SettingsSegmentedControl keyboard', () => {
  function renderThree(onChange = vi.fn()): { onChange: ReturnType<typeof vi.fn> } {
    render(
      <TooltipProvider>
        <SettingsSegmentedControl<string>
          value="b"
          onChange={onChange}
          ariaLabel="Mode"
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
            { value: 'c', label: 'C', disabled: true, tooltip: 'Not available' }
          ]}
        />
      </TooltipProvider>
    )
    return { onChange }
  }

  // Radio groups are one Tab stop; arrows move and select within the group.
  it('keeps a single tab stop on the checked option', () => {
    renderThree()
    const tabStops = screen.getAllByRole('radio').filter((r) => r.getAttribute('tabindex') === '0')
    expect(tabStops.map((r) => r.textContent)).toEqual(['B'])
  })

  it('selects with arrows, wraps past the ends and jumps with Home/End', () => {
    const { onChange } = renderThree()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'B' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('a')
    expect(document.activeElement?.textContent).toBe('A')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'ArrowLeft' })
    expect(document.activeElement?.textContent).toBe('C')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'C' }), { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('a')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'End' })
    expect(document.activeElement?.textContent).toBe('C')
  })

  it('ignores arrows with a modifier held', () => {
    const { onChange } = renderThree()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'B' }), { key: 'ArrowLeft', metaKey: true })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('only moves focus in manual activation', () => {
    const onChange = vi.fn()
    render(
      <TooltipProvider>
        <SettingsSegmentedControl<string>
          value="x"
          onChange={onChange}
          activation="manual"
          ariaLabel="Manual"
          options={[
            { value: 'x', label: 'X' },
            { value: 'y', label: 'Y' }
          ]}
        />
      </TooltipProvider>
    )
    fireEvent.keyDown(screen.getByRole('radio', { name: 'X' }), { key: 'ArrowRight' })
    expect(document.activeElement?.textContent).toBe('Y')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('focuses an unavailable option without selecting it', () => {
    const { onChange } = renderThree()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'B' }), { key: 'ArrowRight' })
    expect(document.activeElement?.textContent).toBe('C')
    expect(onChange).not.toHaveBeenCalled()
  })
})
