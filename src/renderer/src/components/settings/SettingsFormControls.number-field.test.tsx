// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NumberField } from './SettingsFormControls'

afterEach(cleanup)

describe('NumberField optional value', () => {
  it('shows the automatic placeholder and resets when the input is cleared', () => {
    const onReset = vi.fn()
    const { rerender } = render(
      <NumberField
        label="Minimum Contrast"
        description="Contrast floor"
        value={undefined}
        min={1}
        max={21}
        placeholder="Automatic"
        onChange={vi.fn()}
        onReset={onReset}
      />
    )
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    expect(input.placeholder).toBe('Automatic')
    expect(input.value).toBe('')

    rerender(
      <NumberField
        label="Minimum Contrast"
        description="Contrast floor"
        value={7}
        min={1}
        max={21}
        placeholder="Automatic"
        onChange={vi.fn()}
        onReset={onReset}
      />
    )
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(onReset).toHaveBeenCalledOnce()
    expect(input.value).toBe('')
  })
})
