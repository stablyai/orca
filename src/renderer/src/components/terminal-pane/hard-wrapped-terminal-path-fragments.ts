export type HardWrappedPathFragmentRow = {
  text: string
  sourceText: string
  columns: number[]
  isWrapped: boolean
  lineLength: number
}

const HARD_WRAPPED_PATH_FRAGMENT_PATTERN = /^[\p{L}\p{M}\p{N}._~@%+=:,/\\()-]+$/u

export function isHardWrappedPathFragment(text: string): boolean {
  return HARD_WRAPPED_PATH_FRAGMENT_PATTERN.test(text) && /[\p{L}\p{N}]/u.test(text)
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

function previousCodePointStartIndex(text: string, index: number): number {
  const lastCodeUnit = text.charCodeAt(index - 1)
  const previousCodeUnit = text.charCodeAt(index - 2)
  const hasSurrogatePair =
    lastCodeUnit >= 0xdc00 &&
    lastCodeUnit <= 0xdfff &&
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff
  return hasSurrogatePair ? index - 2 : index - 1
}

export function getHardWrappedPathSuffix(
  row: HardWrappedPathFragmentRow
): HardWrappedPathFragmentRow | null {
  let startIndex = row.text.length
  while (startIndex > 0) {
    const previousIndex = previousCodePointStartIndex(row.text, startIndex)
    if (!HARD_WRAPPED_PATH_FRAGMENT_PATTERN.test(row.text.slice(previousIndex, startIndex))) {
      break
    }
    startIndex = previousIndex
  }
  const suffix = sliceHardWrappedPathFragmentRow(row, startIndex, row.text.length)
  return isHardWrappedPathContinuation(suffix.text) ? suffix : null
}

export function getHardWrappedPathPrefix(
  row: HardWrappedPathFragmentRow
): HardWrappedPathFragmentRow | null {
  let endIndex = 0
  while (endIndex < row.text.length) {
    const codePoint = row.text.codePointAt(endIndex)
    const nextIndex = endIndex + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1)
    if (!HARD_WRAPPED_PATH_FRAGMENT_PATTERN.test(row.text.slice(endIndex, nextIndex))) {
      break
    }
    endIndex = nextIndex
  }
  const prefix = sliceHardWrappedPathFragmentRow(row, 0, endIndex)
  return isHardWrappedPathContinuation(prefix.text) ? prefix : null
}
