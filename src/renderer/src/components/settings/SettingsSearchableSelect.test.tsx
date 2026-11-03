// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SettingsSearchableSelect,
  type SettingsSearchableSelectGroup
} from './SettingsSearchableSelect'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const groups: SettingsSearchableSelectGroup[] = [
  {
    key: 'installed',
    options: [
      { value: 'first', label: 'First' },
      { value: 'second', label: 'Second' }
    ]
  }
]

function picker(
  overrides: Partial<React.ComponentProps<typeof SettingsSearchableSelect>> = {}
): React.JSX.Element {
  return (
    <SettingsSearchableSelect
      ariaLabel="Theme"
      value="first"
      groups={groups}
      onValueChange={vi.fn()}
      searchPlaceholder="Search themes"
      {...overrides}
    />
  )
}

async function openPicker(): Promise<HTMLInputElement> {
  fireEvent.click(screen.getByRole('combobox', { name: 'Theme' }))
  return screen.findByPlaceholderText<HTMLInputElement>('Search themes')
}

afterEach(cleanup)

describe('SettingsSearchableSelect', () => {
  it('selects a matching catalog result that arrives after searching', async () => {
    const onValueChange = vi.fn()
    const browse = vi.fn()
    const actions = [{ key: 'browse', label: 'Browse themes', onSelect: browse }]
    const { rerender } = render(
      picker({ onValueChange, actions, status: <div>Loading themes</div> })
    )
    const input = await openPicker()
    fireEvent.change(input, { target: { value: 'tokyo' } })
    rerender(
      picker({
        onValueChange,
        actions,
        groups: [...groups, { key: 'catalog', options: [{ value: 'tokyo', label: 'Tokyo Night' }] }]
      })
    )

    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: 'Tokyo Night' }).getAttribute('aria-selected')
      ).toBe('true')
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('tokyo')
    expect(browse).not.toHaveBeenCalled()
  })

  it('follows an externally changed selection without restoring the previous value on Enter', async () => {
    const onValueChange = vi.fn()
    const { rerender } = render(picker({ onValueChange }))
    const input = await openPicker()
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'First' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )

    rerender(picker({ value: 'second', onValueChange }))
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Second' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('follows an external selection that matches an active search', async () => {
    const onValueChange = vi.fn()
    const { rerender } = render(picker({ onValueChange }))
    const input = await openPicker()
    fireEvent.change(input, { target: { value: 's' } })
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'First' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )

    rerender(picker({ value: 'second', onValueChange }))
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Second' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('preserves keyboard navigation across an unrelated rerender', async () => {
    const onValueChange = vi.fn()
    const { rerender } = render(picker({ onValueChange }))
    const input = await openPicker()
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'First' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'Second' }).getAttribute('aria-selected')).toBe(
      'true'
    )
    rerender(picker({ onValueChange, groups: [...groups] }))
    expect(screen.getByRole('option', { name: 'Second' }).getAttribute('aria-selected')).toBe(
      'true'
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('second')
  })

  it('keeps the browse action keyboard-accessible without selecting a theme', async () => {
    const user = userEvent.setup()
    const browse = vi.fn()
    const onValueChange = vi.fn()
    render(
      picker({
        onValueChange,
        actions: [{ key: 'browse', label: 'Browse themes', onSelect: browse }]
      })
    )
    const input = await openPicker()
    await waitFor(() => expect(document.activeElement).toBe(input))

    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Browse themes' }))
    await user.keyboard('{Enter}')
    expect(browse).toHaveBeenCalledOnce()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('does not select disabled search results', async () => {
    const onValueChange = vi.fn()
    render(
      picker({
        onValueChange,
        groups: [
          ...groups,
          {
            key: 'catalog',
            options: [{ value: 'tokyo', label: 'Tokyo Night', disabled: true }]
          }
        ]
      })
    )
    const input = await openPicker()
    fireEvent.change(input, { target: { value: 'tokyo' } })
    expect(screen.getByRole('option', { name: 'Tokyo Night' }).getAttribute('aria-disabled')).toBe(
      'true'
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it.each(['ArrowDown', 'ArrowUp'])('opens on %s from the closed trigger', async (key) => {
    render(picker())
    const trigger = screen.getByRole('combobox', { name: 'Theme' })
    fireEvent.keyDown(trigger, { key })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByPlaceholderText('Search themes')).toBeTruthy()
  })

  it('does not open for modified shortcuts or composition keys', () => {
    render(picker())
    const trigger = screen.getByRole('combobox', { name: 'Theme' })
    fireEvent.keyDown(trigger, { key: 'e', metaKey: true })
    fireEvent.keyDown(trigger, { key: 'e', isComposing: true })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens and seeds the search from a printable key on the closed trigger', async () => {
    const onValueChange = vi.fn()
    render(picker({ onValueChange }))
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Theme' }), { key: 'e' })

    const input = await screen.findByPlaceholderText<HTMLInputElement>('Search themes')
    expect(input.value).toBe('e')
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Second' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('second')
  })

  it.each([
    ['line', WheelEvent.DOM_DELTA_LINE, 3, 48],
    ['page', WheelEvent.DOM_DELTA_PAGE, 1, 200]
  ])('scrolls by %s wheel units', async (_label, deltaMode, deltaY, expected) => {
    render(picker())
    await openPicker()
    const list = screen.getByRole('listbox')
    Object.defineProperties(list, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200, configurable: true }
    })
    fireEvent.wheel(list, { deltaMode, deltaY })
    expect(list.scrollTop).toBe(expected)
  })
})
