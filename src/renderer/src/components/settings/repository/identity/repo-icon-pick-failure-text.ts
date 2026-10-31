import { translate } from '@/i18n/i18n'
import {
  REPO_ICON_PICK_FAILURE_COPY as EN,
  type RepoIconPickFailure,
  type RepoIconPickFailureCode
} from '../../../../../../shared/repo-icon-pick-failure-copy'

const COPY: Record<RepoIconPickFailureCode, () => string> = {
  notPng: () => translate('settings.repository.iconPickErrors.notPng', EN.notPng),
  unsupportedImage: () =>
    translate('settings.repository.iconPickErrors.unsupportedImage', EN.unsupportedImage),
  sourceTooLarge: () =>
    translate('settings.repository.iconPickErrors.sourceTooLarge', EN.sourceTooLarge),
  tooLarge: () => translate('settings.repository.iconPickErrors.tooLarge', EN.tooLarge)
}

function isRepoIconPickFailureCode(code: unknown): code is RepoIconPickFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** Unknown or uncoded failures show main's English text. */
export function repoIconPickFailureText(failure: RepoIconPickFailure): string {
  return isRepoIconPickFailureCode(failure.errorCode) ? COPY[failure.errorCode]() : failure.error
}
