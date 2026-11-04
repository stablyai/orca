// One English table for Create project failures: main builds the wire `error`, the renderer translates by code.
export const REPO_CREATE_FAILURE_COPY = {
  nameEmpty: 'Name cannot be empty',
  nameInvalid: 'Name cannot contain slashes or be "." / ".."',
  parentRequired: 'Parent directory is required',
  parentNotAbsolute: 'Parent directory must be an absolute path',
  parentInaccessible: 'Cannot access parent directory: {{detail}}',
  targetInaccessible: 'Cannot access target path: {{detail}}',
  targetNotEmpty: '"{{name}}" already exists at this location and is not empty.',
  targetNotFolder: '"{{name}}" already exists at this location and is not a folder.',
  readDirectoryFailed: 'Failed to read directory: {{detail}}',
  createDirectoryFailed: 'Failed to create directory: {{detail}}',
  prepareDirectoryFailed: 'Failed to prepare directory: {{detail}}',
  gitIdentityMissing:
    'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.',
  gitInitFailed: 'Failed to initialize git repository: {{detail}}',
  initialCommitFailed: 'Failed to create initial commit: {{detail}}'
} as const

export type RepoCreateFailureCode = keyof typeof REPO_CREATE_FAILURE_COPY

/** Wire shape: `error` stays English for older clients; `errorDetail` is verbatim fs/git text. */
export type RepoCreateFailure = {
  error: string
  errorCode?: string
  errorParams?: Record<string, string | number>
  errorDetail?: string
}

export function repoCreateFailure(
  errorCode: RepoCreateFailureCode,
  values: { name?: string; detail?: string } = {}
): RepoCreateFailure {
  // One pass so a name containing "{{detail}}" stays verbatim.
  const error = REPO_CREATE_FAILURE_COPY[errorCode].replace(
    /\{\{(name|detail)\}\}/g,
    (_slot, slot: 'name' | 'detail') => values[slot] ?? ''
  )
  return {
    error,
    errorCode,
    ...(values.name !== undefined ? { errorParams: { name: values.name } } : {}),
    ...(values.detail !== undefined ? { errorDetail: values.detail } : {})
  }
}
