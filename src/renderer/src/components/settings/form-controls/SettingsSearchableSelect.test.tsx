// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))

import { SettingsSearchableSelect } from './SettingsSearchableSelect'

beforeAll(() => {
  // cmdk scrolls the highlighted item into view; the test DOM has no layout.
  Element.prototype.scrollIntoView ??= () => {}
})

afterEach(cleanup)

function renderSelect({
  navigableActions = false,
  onAction = vi.fn(),
  onValueChange = vi.fn(),
  onHeadingAction
}: {
  navigableActions?: boolean
  onAction?: () => void
  onValueChange?: (value: string) => void
  onHeadingAction?: () => void
}) {
  render(
    <SettingsSearchableSelect
      ariaLabel="Theme"
      value="a"
      open
      navigableActions={navigableActions}
      groups={[
        {
          key: 'themes',
          heading: 'Themes',
          headingAction: onHeadingAction
            ? { label: 'Browse', ariaLabel: 'Browse themes online', onSelect: onHeadingAction }
            : undefined,
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' }
          ]
        }
      ]}
      onValueChange={onValueChange}
      searchPlaceholder="Search themes…"
      actions={[{ key: 'browse', label: 'Browse themes', onSelect: onAction }]}
    />
  )
  return screen.getByPlaceholderText('Search themes…')
}

describe('SettingsSearchableSelect footer actions', () => {
  it('reaches a navigable footer action with ArrowDown past the last option', () => {
    const onAction = vi.fn()
    const onValueChange = vi.fn()
    const input = renderSelect({ navigableActions: true, onAction, onValueChange })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('runs a navigable footer action on Enter when the query matches nothing', () => {
    const onAction = vi.fn()
    const input = renderSelect({ navigableActions: true, onAction })
    fireEvent.change(input, { target: { value: 'zzz' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('keeps plain footer actions out of keyboard selection by default', () => {
    const onAction = vi.fn()
    const input = renderSelect({ onAction })
    fireEvent.change(input, { target: { value: 'zzz' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('runs a heading action on click without choosing an option', () => {
    const onValueChange = vi.fn()
    const onHeadingAction = vi.fn()
    renderSelect({ onValueChange, onHeadingAction })
    fireEvent.click(screen.getByRole('button', { name: 'Browse themes online' }))
    expect(onHeadingAction).toHaveBeenCalledTimes(1)
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
