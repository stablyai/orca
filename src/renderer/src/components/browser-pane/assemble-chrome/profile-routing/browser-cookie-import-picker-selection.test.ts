import { expect, it } from 'vitest'
import {
  getPickerSelection,
  INITIAL_PICKER_SEARCH,
  reducePickerSearch
} from './browser-cookie-import-picker-selection'

it('keeps an explicit file choice through inventory changes and clears it on query edits', () => {
  const pending = reducePickerSearch(INITIAL_PICKER_SEARCH, { type: 'edit-query', query: 'client' })
  const chosen = reducePickerSearch(pending, {
    type: 'select',
    selection: { rowsKey: 'file only', value: 'from-file' }
  })
  expect(getPickerSelection(chosen, 'Client A and file')).toBe('from-file')

  const edited = reducePickerSearch(chosen, { type: 'edit-query', query: 'clientq' })
  const restored = reducePickerSearch(edited, { type: 'edit-query', query: 'client' })
  expect(getPickerSelection(restored, 'file only')).toBeNull()
})
