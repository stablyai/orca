// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleServicePicker } from './GoogleServicePicker'

afterEach(cleanup)

function row(name: string): HTMLElement {
  const label = screen.getByText(name).closest('label')
  if (!label) {
    throw new Error(`no row for ${name}`)
  }
  return label
}

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

  it('puts the logo first and the checkbox last, with three logos for files', () => {
    render(<GoogleServicePicker value={[]} onChange={vi.fn()} />)
    const files = row('Drive, Docs and Sheets')
    expect(files.lastElementChild?.getAttribute('role')).toBe('checkbox')
    expect(files.firstElementChild?.querySelectorAll('img')).toHaveLength(3)
    expect(row('Gmail').firstElementChild?.querySelectorAll('img')).toHaveLength(1)
  })
})
