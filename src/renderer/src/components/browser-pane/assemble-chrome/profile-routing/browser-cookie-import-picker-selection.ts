export const FROM_FILE_VALUE = 'from-file'

type PickerSelection = { rowsKey: string; value: string }
type PickerSearch = { query: string; selection: PickerSelection | null }
type PickerSearchEvent =
  | { type: 'edit-query'; query: string }
  | { type: 'select'; selection: PickerSelection }

export const INITIAL_PICKER_SEARCH: PickerSearch = { query: '', selection: null }

export function reducePickerSearch(state: PickerSearch, event: PickerSearchEvent): PickerSearch {
  if (event.type === 'edit-query') {
    return { query: event.query, selection: null }
  }
  return { ...state, selection: event.selection }
}

export function getPickerSelection(state: PickerSearch, rowsKey: string): string | null {
  const { selection } = state
  // The file action stays available when the browser probe changes the profile rows.
  if (selection?.value === FROM_FILE_VALUE || selection?.rowsKey === rowsKey) {
    return selection.value
  }
  return null
}
