import type { CombinedDiffReviewFileState, CombinedDiffReviewState } from '../../../../shared/types'

export type CombinedDiffReviewPresentFile = {
  key: string
  diffIdentity: string
}

const COMBINED_DIFF_REVIEW_FILE_CAP = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeFileState(key: string, value: unknown): CombinedDiffReviewFileState | null {
  if (!isRecord(value)) {
    return null
  }
  const storedKey = typeof value.key === 'string' && value.key ? value.key : key
  if (
    typeof value.reviewedAt !== 'number' ||
    !Number.isFinite(value.reviewedAt) ||
    typeof value.diffIdentity !== 'string' ||
    value.diffIdentity.length === 0
  ) {
    return null
  }
  return {
    key: storedKey,
    reviewedAt: value.reviewedAt,
    diffIdentity: value.diffIdentity
  }
}

export function normalizeCombinedDiffReviewState(value: unknown): CombinedDiffReviewState {
  if (!isRecord(value) || !isRecord(value.files)) {
    return { version: 1, files: {} }
  }
  const files: Record<string, CombinedDiffReviewFileState> = {}
  for (const [key, candidate] of Object.entries(value.files)) {
    const state = normalizeFileState(key, candidate)
    if (state) {
      files[state.key] = state
    }
  }
  return {
    version: 1,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : undefined,
    files
  }
}

export function markCombinedDiffFileReviewed(
  state: CombinedDiffReviewState,
  key: string,
  diffIdentity: string,
  now: number
): CombinedDiffReviewState {
  const previous = state.files[key]
  if (previous?.diffIdentity === diffIdentity) {
    return state
  }
  return {
    ...state,
    version: 1,
    updatedAt: now,
    files: {
      ...state.files,
      [key]: { key, reviewedAt: now, diffIdentity }
    }
  }
}

export function markCombinedDiffFileUnreviewed(
  state: CombinedDiffReviewState,
  key: string,
  now: number
): CombinedDiffReviewState {
  if (!state.files[key]) {
    return state
  }
  const files = { ...state.files }
  delete files[key]
  return { ...state, version: 1, updatedAt: now, files }
}

export function isCombinedDiffFileReviewed(
  fileState: CombinedDiffReviewFileState | undefined,
  diffIdentity: string
): boolean {
  return fileState !== undefined && fileState.diffIdentity === diffIdentity
}

export function getViewedSectionKeys(
  state: CombinedDiffReviewState,
  present: readonly CombinedDiffReviewPresentFile[]
): Set<string> {
  const keys = new Set<string>()
  for (const file of present) {
    if (isCombinedDiffFileReviewed(state.files[file.key], file.diffIdentity)) {
      keys.add(file.key)
    }
  }
  return keys
}

export function reconcileCombinedDiffReviewState(
  state: CombinedDiffReviewState,
  present: readonly CombinedDiffReviewPresentFile[],
  now: number
): CombinedDiffReviewState {
  const presentByKey = new Map(present.map((file) => [file.key, file.diffIdentity]))
  let files: Record<string, CombinedDiffReviewFileState> | null = null
  const mutableFiles = (): Record<string, CombinedDiffReviewFileState> => {
    files ??= { ...state.files }
    return files
  }

  for (const [key, stored] of Object.entries(state.files)) {
    const currentIdentity = presentByKey.get(key)
    if (currentIdentity !== undefined && stored.diffIdentity !== currentIdentity) {
      delete mutableFiles()[key]
    }
  }

  const nextFiles = files ?? state.files
  const overCapCount = Object.keys(nextFiles).length - COMBINED_DIFF_REVIEW_FILE_CAP
  if (overCapCount > 0) {
    const absent = Object.values(nextFiles)
      .filter((file) => !presentByKey.has(file.key))
      .sort((a, b) => a.reviewedAt - b.reviewedAt)
      .slice(0, overCapCount)
    if (absent.length > 0) {
      const target = mutableFiles()
      for (const file of absent) {
        delete target[file.key]
      }
    }
  }

  if (!files) {
    return state
  }
  return { ...state, version: 1, updatedAt: now, files }
}
