// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsSearchableSelect } from './SettingsSearchableSelect'

afterEach(cleanup)

it('filters by keywords and returns the selected option value', () => {
  const onValueChange = vi.fn()
  render(
    <SettingsSearchableSelect
      ariaLabel="Language"
      value="ko"
      groups={[
        {
          key: 'languages',
          options: [
            { value: 'ko', label: 'Korean', keywords: ['ko'] },
            { value: 'fr', label: 'French', keywords: ['fr'] }
          ]
        }
      ]}
      onValueChange={onValueChange}
      searchPlaceholder="Search languages…"
    />
  )

  fireEvent.click(screen.getByRole('combobox', { name: 'Language' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Search languages…' }), {
    target: { value: 'fr' }
  })

  expect(screen.getByRole('option', { name: 'French' })).toBeTruthy()
  expect(screen.queryByRole('option', { name: 'Korean' })).toBeNull()
  fireEvent.click(screen.getByRole('option', { name: 'French' }))
  expect(onValueChange).toHaveBeenCalledWith('fr')
})

it('closes when disabled and does not reopen when enabled again', () => {
  const picker = (disabled: boolean) => (
    <SettingsSearchableSelect
      ariaLabel="Language"
      value="ko"
      groups={[{ key: 'languages', options: [{ value: 'ko', label: 'Korean' }] }]}
      onValueChange={vi.fn()}
      searchPlaceholder="Search languages…"
      disabled={disabled}
    />
  )
  const { rerender } = render(picker(false))
  fireEvent.click(screen.getByRole('combobox', { name: 'Language' }))
  expect(screen.getByRole('combobox', { name: 'Search languages…' })).toBeTruthy()

  rerender(picker(true))
  const trigger = screen.getByRole('combobox', { name: 'Language' })
  expect(trigger.getAttribute('disabled')).not.toBeNull()
  expect(screen.queryByRole('combobox', { name: 'Search languages…' })).toBeNull()

  rerender(picker(false))
  expect(screen.queryByRole('combobox', { name: 'Search languages…' })).toBeNull()
})
