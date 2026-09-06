import type {
  MobileWebProviderReviewDiffPayload,
  MobileWebProviderReviewDiffResult
} from './provider-review-diff-contract'
import { buildMobileWebSourceControlDiffPage } from './source-control-diff-page'
import {
  MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS,
  MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS,
  MOBILE_WEB_DIFF_MAX_ROWS,
  type MobileWebDiffRow
} from './source-control-operation-contract'

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

type ReviewDiffIdentity = Pick<
  MobileWebProviderReviewDiffResult,
  'workspaceId' | 'observedHead' | 'branch' | 'provider' | 'reviewNumber' | 'reviewHead' | 'path'
>

type ReviewDiffPageInput = ReviewDiffIdentity &
  Pick<MobileWebProviderReviewDiffPayload, 'offset' | 'limit' | 'focusLine'> & {
    revision: string
  }

export function buildMobileWebProviderReviewContentDiffPage(
  input: ReviewDiffPageInput & {
    originalContent: string
    modifiedContent: string
  }
): MobileWebProviderReviewDiffResult {
  const built = buildMobileWebSourceControlDiffPage({
    workspaceId: input.workspaceId,
    relativePath: input.path,
    area: 'unstaged',
    revision: input.revision,
    originalContent: input.originalContent,
    modifiedContent: input.modifiedContent,
    offset: 0,
    limit: MOBILE_WEB_DIFF_MAX_ROWS
  })
  if (built.kind === 'too-large') {
    return {
      ...reviewIdentity(input),
      kind: 'too-large',
      reason: built.reason,
      ...(built.characterCount === undefined ? {} : { characterCount: built.characterCount })
    }
  }
  if (built.kind !== 'text') {
    return { ...reviewIdentity(input), kind: 'binary' }
  }
  return paginateReviewRows(input, built.rows, built.truncated)
}

export function buildMobileWebProviderReviewPatchDiffPage(
  input: ReviewDiffPageInput & { patch: string }
): MobileWebProviderReviewDiffResult {
  if (input.patch.length > MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS) {
    return {
      ...reviewIdentity(input),
      kind: 'too-large',
      reason: 'mobile-limit',
      characterCount: input.patch.length
    }
  }
  const parsed = parsePatchRows(input.patch)
  return paginateReviewRows(input, parsed.rows, parsed.truncated)
}

function paginateReviewRows(
  input: ReviewDiffPageInput,
  rows: MobileWebDiffRow[],
  truncated: boolean
): MobileWebProviderReviewDiffResult {
  const focusRow = input.focusLine
    ? rows.find((row) => row.newLineNumber === input.focusLine)
    : undefined
  const offset = focusRow
    ? Math.max(0, Math.min(focusRow.index - Math.floor(input.limit / 2), rows.length - input.limit))
    : input.offset
  const end = Math.min(offset + input.limit, rows.length)
  return {
    ...reviewIdentity(input),
    kind: 'text',
    revision: input.revision,
    offset,
    totalRows: rows.length,
    rows: rows.slice(offset, end),
    nextOffset: end < rows.length ? end : null,
    truncated,
    ...(focusRow ? { focusLine: input.focusLine, focusRowIndex: focusRow.index } : {})
  }
}

function parsePatchRows(patch: string): { rows: MobileWebDiffRow[]; truncated: boolean } {
  const rows: MobileWebDiffRow[] = []
  let oldLine: number | null = null
  let newLine: number | null = null
  for (const value of patch.split(/\r?\n/)) {
    const hunk = HUNK_HEADER.exec(value)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      continue
    }
    if (oldLine === null || newLine === null || value.startsWith('\\')) {
      continue
    }
    const marker = value[0]
    if (marker !== ' ' && marker !== '+' && marker !== '-') {
      continue
    }
    if (rows.length >= MOBILE_WEB_DIFF_MAX_ROWS) {
      return { rows, truncated: true }
    }
    const kind = marker === '+' ? 'add' : marker === '-' ? 'delete' : 'context'
    const text = value.slice(1)
    const textTruncated = text.length > MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS
    rows.push({
      index: rows.length,
      kind,
      text: textTruncated ? text.slice(0, MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS) : text,
      textTruncated,
      ...(kind === 'add' ? {} : { oldLineNumber: oldLine }),
      ...(kind === 'delete' ? {} : { newLineNumber: newLine })
    })
    if (kind !== 'add') {
      oldLine += 1
    }
    if (kind !== 'delete') {
      newLine += 1
    }
  }
  return { rows, truncated: false }
}

function reviewIdentity(input: ReviewDiffIdentity): ReviewDiffIdentity {
  return {
    workspaceId: input.workspaceId,
    observedHead: input.observedHead,
    branch: input.branch,
    provider: input.provider,
    reviewNumber: input.reviewNumber,
    reviewHead: input.reviewHead,
    path: input.path
  }
}
