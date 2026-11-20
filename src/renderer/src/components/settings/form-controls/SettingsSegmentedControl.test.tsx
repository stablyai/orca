// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../ui/tooltip'
import { SettingsSegmentedControl } from './SettingsSegmentedControl'

afterEach(cleanup)

function renderControl(value: string, onChange = vi.fn()) {
  render(
    <TooltipProvider>
      <SettingsSegmentedControl
        ariaLabel="Action"
        value={value}
        onChange={onChange}
        options={[
          { value: 'archive', label: 'Archive' },
          { value: 'soon', label: 'Soon', disabled: true },
          { value: 'delete', label: 'Delete' }
        ]}
      />
    </TooltipProvider>
  )
  return onChange
}

it('keeps one tab stop on the checked option', () => {
  renderControl('delete')
  expect(screen.getByRole('radio', { name: 'Delete' }).tabIndex).toBe(0)
  expect(screen.getByRole('radio', { name: 'Archive' }).tabIndex).toBe(-1)
  expect(screen.getByRole('radio', { name: 'Soon' }).tabIndex).toBe(-1)
})

it('moves to and picks the next available option with the arrow keys, skipping disabled ones', () => {
  const onChange = renderControl('archive')
  const archive = screen.getByRole('radio', { name: 'Archive' })
  archive.focus()
  fireEvent.keyDown(archive, { key: 'ArrowRight' })
  expect(onChange).toHaveBeenLastCalledWith('delete')
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Delete' }))
  onChange.mockClear()
  fireEvent.keyDown(screen.getByRole('radio', { name: 'Delete' }), { key: 'ArrowLeft' })
  expect(onChange).toHaveBeenCalledWith('archive')
  expect(document.activeElement).toBe(archive)
  fireEvent.keyDown(archive, { key: 'Home' })
  expect(onChange).toHaveBeenLastCalledWith('archive')
})

it.each([
  ['ArrowRight', 'delete', 'Delete'],
  ['ArrowLeft', 'archive', 'Archive']
])('navigates %s from a checked disabled option', (key, value, label) => {
  const onChange = renderControl('soon')
  const soon = screen.getByRole('radio', { name: 'Soon' })
  soon.focus()
  fireEvent.keyDown(soon, { key })
  expect(onChange).toHaveBeenCalledWith(value)
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: label }))
})

it('leaves other keys, such as Tab, alone', () => {
  const onChange = renderControl('archive')
  const archive = screen.getByRole('radio', { name: 'Archive' })
  expect(fireEvent.keyDown(archive, { key: 'Tab' })).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})
