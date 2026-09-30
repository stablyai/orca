// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NumberField } from './SettingsFormControls'

afterEach(cleanup)

// #10754: an optional setting needs a way back to "unset". Without a clear path the field can pin a
// value but never restore Orca's automatic behavior, which is the state most users should be in.
describe('NumberField clearable fields', () => {
  it('renders the placeholder and commits nothing while the value is unset', () => {
    render(
      <NumberField
        label="Minimum Contrast Ratio"
        description=""
        value={undefined}
        min={1}
        max={21}
        placeholder="Auto"
        onChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const input = screen.getByLabelText('Minimum Contrast Ratio') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.getAttribute('placeholder')).toBe('Auto')
  })

  it('clears the setting when the field is emptied', () => {
    const onChange = vi.fn()
    const onClear = vi.fn()
    render(
      <NumberField
        label="Minimum Contrast Ratio"
        description=""
        value={1}
        min={1}
        max={21}
        placeholder="Auto"
        onChange={onChange}
        onClear={onClear}
      />
    )

    const input = screen.getByLabelText('Minimum Contrast Ratio')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('still snaps back to the current value when the field is not clearable', () => {
    const onChange = vi.fn()
    render(<NumberField label="Font Size" description="" value={14} min={6} onChange={onChange} />)

    const input = screen.getByLabelText('Font Size') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('14')
  })

  it('clamps a committed value into the min/max window', () => {
    const onChange = vi.fn()
    render(
      <NumberField
        label="Minimum Contrast Ratio"
        description=""
        value={undefined}
        min={1}
        max={21}
        onChange={onChange}
        onClear={vi.fn()}
      />
    )

    const input = screen.getByLabelText('Minimum Contrast Ratio')
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)

    expect(onChange).toHaveBeenCalledWith(21)
  })
})
