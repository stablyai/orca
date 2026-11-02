// One English table for PR/MR start-point failures: main builds the wire `error`, the renderer translates by code.
export const REVIEW_START_POINT_FAILURE_COPY = {
  repoNotFound: 'Repo not found',
  folderUnsupported: 'Folder mode does not support creating worktrees.',
  fetchFailed: 'Failed to fetch {{ref}}: {{detail}}',
  remoteRefMissing: 'Remote ref {{ref}} does not exist after fetch.',
  'github.prNotFound': 'PR #{{number}} not found.',
  'github.prHeadBranchMissing': 'PR #{{number}} has no head branch.',
  'github.forkHeadUnresolved': 'Could not resolve fork PR #{{number}} head after fetch.',
  'github.headShaEmpty': 'Empty SHA resolving PR #{{number}} head.',
  'gitlab.projectNotFound': 'No GitLab project found for this repository.',
  'gitlab.mrNotFound': 'MR !{{number}} not found.',
  'gitlab.mrSourceBranchMissing': 'MR !{{number}} has no source branch.',
  'gitlab.forkHeadUnresolved': 'Could not resolve fork MR !{{number}} head after fetch.'
} as const

export type ReviewStartPointFailureCode = keyof typeof REVIEW_START_POINT_FAILURE_COPY

/** Wire shape: `error` stays English for older clients; `errorDetail` is verbatim git text. */
export type ReviewStartPointFailure = {
  error: string
  errorCode?: string
  errorParams?: Record<string, string | number>
  errorDetail?: string
}

type StartPointValues = { number?: number; ref?: string; detail?: string }

export function reviewStartPointFailure(
  errorCode: ReviewStartPointFailureCode,
  values: StartPointValues = {}
): ReviewStartPointFailure {
  // One pass so a ref containing "{{detail}}" stays verbatim.
  const error = REVIEW_START_POINT_FAILURE_COPY[errorCode].replace(
    /\{\{(number|ref|detail)\}\}/g,
    (_slot, slot: keyof StartPointValues) => String(values[slot] ?? '')
  )
  const errorParams = {
    ...(values.number !== undefined ? { number: values.number } : {}),
    ...(values.ref !== undefined ? { ref: values.ref } : {})
  }
  return {
    error,
    errorCode,
    ...(Object.keys(errorParams).length > 0 ? { errorParams } : {}),
    ...(values.detail !== undefined ? { errorDetail: values.detail } : {})
  }
}
