import { translate } from '@/i18n/i18n'
import {
  EPHEMERAL_VM_FAILURE_COPY as EN,
  type EphemeralVmFailure,
  type EphemeralVmFailureCode
} from '../../../shared/ephemeral-vm-failure-copy'
import type { EphemeralVmRuntimeRecord } from '../../../shared/ephemeral-vm-runtimes'

type Params = Record<string, string | number>

function text(params: Params | undefined, name: string): string | null {
  const value = params?.[name]
  return typeof value === 'string' ? value : null
}

function num(params: Params | undefined, name: string): number | null {
  const value = params?.[name]
  return typeof value === 'number' ? value : null
}

// null = required param missing; caller shows the host's English `error`.
const COPY: Record<EphemeralVmFailureCode, (params: Params | undefined) => string | null> = {
  repoNotFound: (p) => {
    const repoId = text(p, 'repoId')
    return repoId === null
      ? null
      : translate('ephemeralVm.errors.repoNotFound', EN.repoNotFound, { repoId })
  },
  remoteRepoUnsupported: () =>
    translate('ephemeralVm.errors.remoteRepoUnsupported', EN.remoteRepoUnsupported),
  recipeNotFound: (p) => {
    const recipeId = text(p, 'recipeId')
    return recipeId === null
      ? null
      : translate('ephemeralVm.errors.recipeNotFound', EN.recipeNotFound, { recipeId })
  },
  runtimeNotFound: (p) => {
    const runtimeId = text(p, 'runtimeId')
    return runtimeId === null
      ? null
      : translate('ephemeralVm.errors.runtimeNotFound', EN.runtimeNotFound, { runtimeId })
  },
  runtimeRepoMissing: (p) => {
    const runtimeId = text(p, 'runtimeId')
    return runtimeId === null
      ? null
      : translate('ephemeralVm.errors.runtimeRepoMissing', EN.runtimeRepoMissing, { runtimeId })
  },
  provisionCancelled: () =>
    translate('ephemeralVm.errors.provisionCancelled', EN.provisionCancelled),
  startRefUnresolved: (p) => {
    const ref = text(p, 'ref')
    return ref === null
      ? null
      : translate('ephemeralVm.errors.startRefUnresolved', EN.startRefUnresolved, { ref })
  },
  defaultStartRefUnresolved: () =>
    translate('ephemeralVm.errors.defaultStartRefUnresolved', EN.defaultStartRefUnresolved),
  recipeExited: (p) => {
    const exitCode = num(p, 'exitCode')
    return exitCode === null
      ? null
      : translate('ephemeralVm.errors.recipeExited', EN.recipeExited, { exitCode })
  },
  recipeExitedWithoutCode: () =>
    translate('ephemeralVm.errors.recipeExitedWithoutCode', EN.recipeExitedWithoutCode),
  recipeResultMissing: () =>
    translate('ephemeralVm.errors.recipeResultMissing', EN.recipeResultMissing),
  recipeResultNotJsonObject: () =>
    translate('ephemeralVm.errors.recipeResultNotJsonObject', EN.recipeResultNotJsonObject),
  recipeResultPairingCodeInvalid: () =>
    translate(
      'ephemeralVm.errors.recipeResultPairingCodeInvalid',
      EN.recipeResultPairingCodeInvalid
    ),
  recipeResultProjectRootNotAbsolute: () =>
    translate(
      'ephemeralVm.errors.recipeResultProjectRootNotAbsolute',
      EN.recipeResultProjectRootNotAbsolute
    ),
  provisionedRootResultRequired: () =>
    translate('ephemeralVm.errors.provisionedRootResultRequired', EN.provisionedRootResultRequired),
  provisionedRootNotConfigured: () =>
    translate('ephemeralVm.errors.provisionedRootNotConfigured', EN.provisionedRootNotConfigured),
  destroyExited: (p) => {
    const exitCode = num(p, 'exitCode')
    return exitCode === null
      ? null
      : translate('ephemeralVm.errors.destroyExited', EN.destroyExited, { exitCode })
  },
  destroyExitedWithoutCode: () =>
    translate('ephemeralVm.errors.destroyExitedWithoutCode', EN.destroyExitedWithoutCode),
  destroyFailed: () => translate('ephemeralVm.errors.destroyFailed', EN.destroyFailed),
  destroyDisabled: () => translate('ephemeralVm.errors.destroyDisabled', EN.destroyDisabled),
  cleanupStopped: () => translate('ephemeralVm.errors.cleanupStopped', EN.cleanupStopped),
  cleanupInterrupted: () =>
    translate('ephemeralVm.errors.cleanupInterrupted', EN.cleanupInterrupted),
  sshTargetRemoveFailed: () =>
    translate('ephemeralVm.errors.sshTargetRemoveFailed', EN.sshTargetRemoveFailed)
}

function isEphemeralVmFailureCode(code: string): code is EphemeralVmFailureCode {
  return Object.hasOwn(COPY, code)
}

/** Localized text for a coded failure; uncoded, unknown, or incomplete codes show the host's English. */
export function ephemeralVmErrorText(failure: EphemeralVmFailure): string {
  const code = failure.errorCode
  if (!code || !isEphemeralVmFailureCode(code)) {
    return failure.error
  }
  return COPY[code](failure.errorParams) ?? failure.error
}

export function ephemeralVmCleanupErrorText(
  runtime: Pick<
    EphemeralVmRuntimeRecord,
    'cleanupLastError' | 'cleanupLastErrorCode' | 'cleanupLastErrorParams'
  >
): string | null {
  if (!runtime.cleanupLastError) {
    return null
  }
  return ephemeralVmErrorText({
    error: runtime.cleanupLastError,
    errorCode: runtime.cleanupLastErrorCode,
    errorParams: runtime.cleanupLastErrorParams
  })
}
