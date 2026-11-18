// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleServicePicker } from './GoogleServicePicker'

afterEach(cleanup)

describe('Google service picker', () => {
  it('toggles a service from anywhere on its row', () => {
    const onChange = vi.fn()
    render(<GoogleServicePicker value={['gmail']} onChange={onChange} />)
    fireEvent.click(screen.getByText('See, create and move events'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(['gmail', 'calendar'])
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
