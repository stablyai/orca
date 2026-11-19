import { translate } from '@/i18n/i18n'
import {
  MAX_REPO_ICON_INPUT_BYTES,
  MAX_REPO_ICON_UPLOAD_BYTES
} from '../../../../../../shared/repository/appearance/repo-icon'
import {
  REPO_ICON_PICK_FAILURE_COPY as EN,
  type RepoIconPickFailure,
  type RepoIconPickFailureCode
} from '../../../../../../shared/repository/appearance/repo-icon-pick-failure-copy'
import { formatBytes } from '../../../../../../shared/text/format-bytes'

const COPY: Record<RepoIconPickFailureCode, () => string> = {
  notPng: () => translate('settings.repository.iconPickErrors.notPng', EN.notPng),
  tooLarge: () =>
    translate('settings.repository.iconPickErrors.tooLarge', EN.tooLarge, {
      limit: formatBytes(MAX_REPO_ICON_INPUT_BYTES)
    }),
  dimensionsTooLarge: () =>
    translate('settings.repository.iconPickErrors.dimensionsTooLarge', EN.dimensionsTooLarge),
  invalidImage: () => translate('settings.repository.iconPickErrors.invalidImage', EN.invalidImage),
  cannotCompress: () =>
    translate('settings.repository.iconPickErrors.cannotCompress', EN.cannotCompress, {
      limit: formatBytes(MAX_REPO_ICON_UPLOAD_BYTES)
    })
}

function isRepoIconPickFailureCode(code: unknown): code is RepoIconPickFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** Unknown or uncoded failures show main's English text. */
export function repoIconPickFailureText(failure: RepoIconPickFailure): string {
  return isRepoIconPickFailureCode(failure.errorCode) ? COPY[failure.errorCode]() : failure.error
}
