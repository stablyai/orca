import { translate } from '@/i18n/i18n'
import {
  REPO_CREATE_FAILURE_COPY as EN,
  type RepoCreateFailure,
  type RepoCreateFailureCode
} from '../../../../shared/repo-create-failure-copy'

type CopyValues = { name: string | null; detail: string | null }

// null = required values missing; caller shows the host's English `error`.
const COPY: Record<RepoCreateFailureCode, (values: CopyValues) => string | null> = {
  nameEmpty: () => translate('sidebar.createProject.errors.nameEmpty', EN.nameEmpty),
  nameInvalid: () => translate('sidebar.createProject.errors.nameInvalid', EN.nameInvalid),
  parentRequired: () => translate('sidebar.createProject.errors.parentRequired', EN.parentRequired),
  parentNotAbsolute: () =>
    translate('sidebar.createProject.errors.parentNotAbsolute', EN.parentNotAbsolute),
  parentInaccessible: ({ detail }) =>
    detail === null
      ? null
      : translate('sidebar.createProject.errors.parentInaccessible', EN.parentInaccessible, {
          detail
        }),
  targetInaccessible: ({ detail }) =>
    detail === null
      ? null
      : translate('sidebar.createProject.errors.targetInaccessible', EN.targetInaccessible, {
          detail
        }),
  targetNotEmpty: ({ name }) =>
    name === null
      ? null
      : translate('sidebar.createProject.errors.targetNotEmpty', EN.targetNotEmpty, { name }),
  targetNotFolder: ({ name }) =>
    name === null
      ? null
      : translate('sidebar.createProject.errors.targetNotFolder', EN.targetNotFolder, { name }),
  readDirectoryFailed: ({ detail }) =>
    detail === null
      ? null
      : translate('sidebar.createProject.errors.readDirectoryFailed', EN.readDirectoryFailed, {
          detail
        }),
  createDirectoryFailed: ({ detail }) =>
    detail === null
      ? null
      : translate('sidebar.createProject.errors.createDirectoryFailed', EN.createDirectoryFailed, {
          detail
        }),
  prepareDirectoryFailed: ({ detail }) =>
    detail === null
      ? null
      : translate(
          'sidebar.createProject.errors.prepareDirectoryFailed',
          EN.prepareDirectoryFailed,
          { detail }
        ),
  gitIdentityMissing: () =>
    translate('sidebar.createProject.errors.gitIdentityMissing', EN.gitIdentityMissing),
  gitInitFailed: ({ detail }) =>
    detail === null
      ? null
      : translate('sidebar.createProject.errors.gitInitFailed', EN.gitInitFailed, { detail }),
  initialCommitFailed: ({ detail }) =>
    detail === null
      ? null
      : translate('sidebar.createProject.errors.initialCommitFailed', EN.initialCommitFailed, {
          detail
        })
}

function isRepoCreateFailureCode(code: unknown): code is RepoCreateFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** Unknown codes (newer host) and uncoded results (older host) show the host's English text. */
export function repoCreateErrorText(failure: RepoCreateFailure): string {
  if (!isRepoCreateFailureCode(failure.errorCode)) {
    return failure.error
  }
  const name = failure.errorParams?.name
  return (
    COPY[failure.errorCode]({
      name: typeof name === 'string' ? name : null,
      detail: typeof failure.errorDetail === 'string' ? failure.errorDetail : null
    }) ?? failure.error
  )
}
