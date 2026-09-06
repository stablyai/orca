import {
  MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS,
  MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS,
  MOBILE_WEB_DIFF_MAX_ROWS,
  MOBILE_WEB_DIFF_SOURCE_LINE_LIMIT,
  type MobileWebDiffRow,
  type MobileWebSourceControlDiffResult
} from './source-control-operation-contract'

const MOBILE_WEB_DIFF_LCS_MAX_CELLS = 200_000

type DiffIdentity = {
  workspaceId: string
  relativePath: string
  area: 'staged' | 'unstaged' | 'untracked'
}

type BuildDiffPageInput = DiffIdentity & {
  revision: string
  originalContent: string
  modifiedContent: string
  offset: number
  limit: number
}

type DiffRowWithoutIndex = Omit<MobileWebDiffRow, 'index'>

export function buildMobileWebSourceControlDiffPage(
  input: BuildDiffPageInput
): MobileWebSourceControlDiffResult {
  const characterCount = input.originalContent.length + input.modifiedContent.length
  if (characterCount > MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS) {
    return largeDiff(input, characterCount)
  }
  const originalLines = splitBoundedDiffLines(input.originalContent)
  const modifiedLines = splitBoundedDiffLines(input.modifiedContent)
  if (!originalLines || !modifiedLines) {
    return largeDiff(input, characterCount)
  }

  const rows =
    originalLines.length * modifiedLines.length <= MOBILE_WEB_DIFF_LCS_MAX_CELLS
      ? buildLcsRows(originalLines, modifiedLines)
      : buildPrefixSuffixRows(originalLines, modifiedLines)
  const truncated = rows.length > MOBILE_WEB_DIFF_MAX_ROWS
  const totalRows = Math.min(rows.length, MOBILE_WEB_DIFF_MAX_ROWS)
  const pageEnd = Math.min(input.offset + input.limit, totalRows)
  const pageRows = rows.slice(input.offset, pageEnd)

  return {
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    area: input.area,
    kind: 'text',
    revision: input.revision,
    offset: input.offset,
    totalRows,
    rows: pageRows,
    nextOffset: pageEnd < totalRows ? pageEnd : null,
    truncated
  }
}

function largeDiff(input: DiffIdentity, characterCount: number): MobileWebSourceControlDiffResult {
  return {
    ...input,
    kind: 'too-large',
    reason: 'mobile-limit',
    characterCount
  }
}

function splitBoundedDiffLines(content: string): string[] | null {
  if (content.length === 0) {
    return []
  }
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) {
      continue
    }
    const end = index > start && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    lines.push(content.slice(start, end))
    if (lines.length > MOBILE_WEB_DIFF_SOURCE_LINE_LIMIT) {
      return null
    }
    start = index + 1
  }
  if (start < content.length) {
    lines.push(content.slice(start))
  }
  return lines.length > MOBILE_WEB_DIFF_SOURCE_LINE_LIMIT ? null : lines
}

function buildLcsRows(original: string[], modified: string[]): MobileWebDiffRow[] {
  const width = modified.length + 1
  const table = new Uint32Array((original.length + 1) * width)
  for (let left = original.length - 1; left >= 0; left -= 1) {
    for (let right = modified.length - 1; right >= 0; right -= 1) {
      table[left * width + right] =
        original[left] === modified[right]
          ? table[(left + 1) * width + right + 1] + 1
          : Math.max(table[(left + 1) * width + right], table[left * width + right + 1])
    }
  }

  const rows: MobileWebDiffRow[] = []
  let left = 0
  let right = 0
  while (left < original.length && right < modified.length) {
    if (original[left] === modified[right]) {
      if (!appendRow(rows, row('context', original[left] ?? '', left + 1, right + 1))) {
        return rows
      }
      left += 1
      right += 1
    } else if (table[(left + 1) * width + right] >= table[left * width + right + 1]) {
      if (!appendRow(rows, row('delete', original[left] ?? '', left + 1))) {
        return rows
      }
      left += 1
    } else {
      if (!appendRow(rows, row('add', modified[right] ?? '', undefined, right + 1))) {
        return rows
      }
      right += 1
    }
  }
  while (left < original.length) {
    if (!appendRow(rows, row('delete', original[left] ?? '', left + 1))) {
      return rows
    }
    left += 1
  }
  while (right < modified.length) {
    if (!appendRow(rows, row('add', modified[right] ?? '', undefined, right + 1))) {
      return rows
    }
    right += 1
  }
  return rows
}

function buildPrefixSuffixRows(original: string[], modified: string[]): MobileWebDiffRow[] {
  let prefix = 0
  while (
    prefix < original.length &&
    prefix < modified.length &&
    original[prefix] === modified[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix + prefix < original.length &&
    suffix + prefix < modified.length &&
    original[original.length - suffix - 1] === modified[modified.length - suffix - 1]
  ) {
    suffix += 1
  }

  const rows: MobileWebDiffRow[] = []
  for (let index = 0; index < prefix; index += 1) {
    if (!appendRow(rows, row('context', original[index] ?? '', index + 1, index + 1))) {
      return rows
    }
  }
  for (let index = prefix; index < original.length - suffix; index += 1) {
    if (!appendRow(rows, row('delete', original[index] ?? '', index + 1))) {
      return rows
    }
  }
  for (let index = prefix; index < modified.length - suffix; index += 1) {
    if (!appendRow(rows, row('add', modified[index] ?? '', undefined, index + 1))) {
      return rows
    }
  }
  for (let index = original.length - suffix; index < original.length; index += 1) {
    const modifiedIndex = modified.length - suffix + index - (original.length - suffix)
    if (!appendRow(rows, row('context', original[index] ?? '', index + 1, modifiedIndex + 1))) {
      return rows
    }
  }
  return rows
}

function row(
  kind: MobileWebDiffRow['kind'],
  value: string,
  oldLineNumber?: number,
  newLineNumber?: number
): DiffRowWithoutIndex {
  const textTruncated = value.length > MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS
  return {
    kind,
    text: textTruncated ? value.slice(0, MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS) : value,
    textTruncated,
    ...(oldLineNumber === undefined ? {} : { oldLineNumber }),
    ...(newLineNumber === undefined ? {} : { newLineNumber })
  }
}

function appendRow(rows: MobileWebDiffRow[], value: DiffRowWithoutIndex): boolean {
  rows.push({ index: rows.length, ...value })
  return rows.length <= MOBILE_WEB_DIFF_MAX_ROWS
}
