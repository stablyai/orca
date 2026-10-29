import { decideEnterAction, type DirEntry } from './remote-file-browser-helpers'

/** -1 means no row: Enter then acts on the typed path, not a listed entry. */
export function initialRemoteFileBrowserHighlight(
  entries: readonly DirEntry[],
  typedPathIsTarget: boolean
): number {
  if (entries.length === 0 || typedPathIsTarget) {
    return -1
  }
  const action = decideEnterAction([...entries])
  return action.type === 'navigate' ? entries.findIndex((entry) => entry.name === action.name) : 0
}

export function stepRemoteFileBrowserHighlight(
  index: number,
  delta: 1 | -1,
  length: number
): number {
  if (length === 0) {
    return -1
  }
  if (index < 0) {
    return delta === 1 ? 0 : length - 1
  }
  return Math.min(Math.max(index + delta, 0), length - 1)
}
