export type HardWrappedPathFragmentRow = {
  text: string
  sourceText: string
  columns: number[]
  isWrapped: boolean
  lineLength: number
}

const HARD_WRAPPED_PATH_FRAGMENT_PATTERN = /^[A-Za-z0-9._~@%+=:,/\\-]+$/

export function isHardWrappedPathFragment(text: string): boolean {
  return HARD_WRAPPED_PATH_FRAGMENT_PATTERN.test(text) && /[A-Za-z0-9]/.test(text)
}

export function isIncompleteHardWrappedPathStart(text: string): boolean {
  // Why: a terminal row can end immediately after a complete root, drive, or
  // relative prefix, before the continuation contributes path-name characters.
  return /^(?:[/\\]|\.{1,2}\/|~\/|[A-Za-z]:)$/.test(text)
}

export function isHardWrappedPathContinuation(text: string): boolean {
  return isHardWrappedPathFragment(text) || isIncompleteHardWrappedPathStart(text)
}

export function canStartHardWrappedPath(text: string): boolean {
  if (!isHardWrappedPathFragment(text)) {
    return /(?:^|[\s•*>-])(?:\/|\.{1,2}\/|[A-Za-z0-9._-]+\/)[A-Za-z0-9._~@%+=:,/\\-]*$/.test(text)
  }

  return /(?:\/|\\)/.test(text)
}

function sliceHardWrappedPathFragmentRow(
  row: HardWrappedPathFragmentRow,
  startIndex: number,
  endIndex: number
): HardWrappedPathFragmentRow {
  return {
    ...row,
    text: row.text.slice(startIndex, endIndex),
    columns: row.columns.slice(startIndex, endIndex + 1)
  }
}

export function getHardWrappedPathSuffix(
  row: HardWrappedPathFragmentRow
): HardWrappedPathFragmentRow | null {
  let startIndex = row.text.length
  while (startIndex > 0 && HARD_WRAPPED_PATH_FRAGMENT_PATTERN.test(row.text[startIndex - 1])) {
    startIndex--
  }
  const suffix = sliceHardWrappedPathFragmentRow(row, startIndex, row.text.length)
  return isHardWrappedPathContinuation(suffix.text) ? suffix : null
}

export function getHardWrappedPathPrefix(
  row: HardWrappedPathFragmentRow
): HardWrappedPathFragmentRow | null {
  let endIndex = 0
  while (
    endIndex < row.text.length &&
    HARD_WRAPPED_PATH_FRAGMENT_PATTERN.test(row.text[endIndex])
  ) {
    endIndex++
  }
  const prefix = sliceHardWrappedPathFragmentRow(row, 0, endIndex)
  return isHardWrappedPathContinuation(prefix.text) ? prefix : null
}
