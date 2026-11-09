import type { OrcaVmRecipeLifecycleMode } from './orca-yaml-hook-types'
import { formatEphemeralVmRecipeTimeout } from './ephemeral-vm-recipe-timeouts'

// One English table for ephemeral VM failures: main builds the wire/persisted English, the renderer translates by code.
export const EPHEMERAL_VM_FAILURE_COPY = {
  repoNotFound: 'Repo not found: {{repoId}}',
  remoteRepoUnsupported: 'Ephemeral VM recipes run on the local desktop host in v1.',
  recipeNotFound: 'Recipe not found: {{recipeId}}',
  runtimeNotFound: 'Unknown ephemeral VM runtime: {{runtimeId}}',
  runtimeRepoMissing: 'Ephemeral VM runtime has no repo id: {{runtimeId}}',
  provisionCancelled: 'Provisioning cancelled.',
  provisionInterrupted:
    'Orca stopped while this VM was being created. Destroy it to release any provider resources.',
  startRefUnresolved: 'Could not resolve provisioned-root start ref: {{ref}}',
  defaultStartRefUnresolved: 'Could not resolve a default provisioned-root start ref.',
  recipeExited: 'Recipe exited with code {{exitCode}}.',
  recipeExitedWithoutCode: 'Recipe exited with code unknown.',
  recipeResultMissing: 'Recipe produced no JSON result.',
  recipeResultNotJsonObject: 'Recipe stdout must be one JSON object.',
  recipeResultPairingCodeInvalid: 'Recipe result pairingCode is not a valid Orca pairing code.',
  recipeResultProjectRootNotAbsolute: 'Recipe result projectRoot must be an absolute runtime path.',
  provisionedRootResultRequired:
    'Provisioned-root recipes must return schemaVersion 2 with checkoutMode "provisioned-root".',
  provisionedRootNotConfigured:
    'Recipe result requests provisioned-root checkout, but the recipe is not configured for it.',
  suspendExited: 'Suspend exited with code {{exitCode}}.',
  suspendExitedWithoutCode: 'Suspend exited with code unknown.',
  resumeExited: 'Resume exited with code {{exitCode}}.',
  resumeExitedWithoutCode: 'Resume exited with code unknown.',
  recipeTimedOut:
    'The recipe {{mode}} step did not finish within {{timeout}}, so Orca stopped it. Check the recipe output, or raise timeoutSeconds in orca.yaml if it needs longer.',
  destroyExited: 'Destroy exited with code {{exitCode}}.',
  destroyExitedWithoutCode: 'Destroy exited with code unknown.',
  destroyFailed: 'Destroy failed.',
  destroyDisabled: 'Destroy is disabled for this recipe.',
  cleanupStopped: 'Cleanup stopped by user.',
  cleanupInterrupted: 'Cleanup was interrupted. Retry cleanup to continue.',
  sshTargetRemoveFailed: 'Failed to remove the hidden SSH target.'
} as const

export type EphemeralVmFailureCode = keyof typeof EPHEMERAL_VM_FAILURE_COPY

type EphemeralVmFailureParams = {
  repoId?: string
  recipeId?: string
  runtimeId?: string
  ref?: string
  exitCode?: number
  mode?: OrcaVmRecipeLifecycleMode
  timeout?: string
  timeoutSeconds?: number
}

/** Wire/persisted shape: `error` stays English for older clients; the code is optional and open. */
export type EphemeralVmFailure = {
  error: string
  errorCode?: string
  errorParams?: Record<string, string | number>
}

export function ephemeralVmFailure(
  errorCode: EphemeralVmFailureCode,
  params: EphemeralVmFailureParams = {}
): EphemeralVmFailure {
  // One pass so an id containing "{{ref}}" stays verbatim.
  const error = EPHEMERAL_VM_FAILURE_COPY[errorCode].replace(
    /\{\{(repoId|recipeId|runtimeId|ref|exitCode|mode|timeout)\}\}/g,
    (_slot, slot: keyof EphemeralVmFailureParams) => String(params[slot] ?? '')
  )
  const errorParams = Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined
    )
  )
  return {
    error,
    errorCode,
    ...(Object.keys(errorParams).length > 0 ? { errorParams } : {})
  }
}

const EXIT_FAILURE_CODES = {
  recipe: ['recipeExited', 'recipeExitedWithoutCode'],
  suspend: ['suspendExited', 'suspendExitedWithoutCode'],
  resume: ['resumeExited', 'resumeExitedWithoutCode'],
  destroy: ['destroyExited', 'destroyExitedWithoutCode']
} as const satisfies Record<string, readonly [EphemeralVmFailureCode, EphemeralVmFailureCode]>

export function ephemeralVmExitFailure(
  step: keyof typeof EXIT_FAILURE_CODES,
  exitCode: number | null
): EphemeralVmFailure {
  const [withCode, withoutCode] = EXIT_FAILURE_CODES[step]
  return exitCode === null
    ? ephemeralVmFailure(withoutCode)
    : ephemeralVmFailure(withCode, { exitCode })
}

export function ephemeralVmTimeoutFailure(
  mode: OrcaVmRecipeLifecycleMode,
  timeoutSeconds: number
): EphemeralVmFailure {
  return ephemeralVmFailure('recipeTimedOut', {
    mode,
    timeout: formatEphemeralVmRecipeTimeout(timeoutSeconds),
    timeoutSeconds
  })
}

/** In-process carrier so a catch site can persist the code next to the English message. */
export class EphemeralVmFailureError extends Error {
  readonly failure: EphemeralVmFailure

  constructor(failure: EphemeralVmFailure) {
    super(failure.error)
    this.name = 'EphemeralVmFailureError'
    this.failure = failure
  }
}

export function ephemeralVmFailureFromError(error: unknown): EphemeralVmFailure {
  if (error instanceof EphemeralVmFailureError) {
    return error.failure
  }
  return { error: error instanceof Error ? error.message : String(error) }
}

/** Runtime-record fields; null (or a plain string) writes undefined so stale codes clear. */
export function toCleanupLastErrorFields(failure: EphemeralVmFailure | null): {
  cleanupLastError: string | undefined
  cleanupLastErrorCode: string | undefined
  cleanupLastErrorParams: Record<string, string | number> | undefined
} {
  return {
    cleanupLastError: failure?.error,
    cleanupLastErrorCode: failure?.errorCode,
    cleanupLastErrorParams: failure?.errorParams
  }
}

/** Suspend/resume record fields; undefined writes nothing, null clears all three. */
export function toLifecycleLastErrorFields(failure: EphemeralVmFailure | null | undefined): {
  lifecycleLastError?: string
  lifecycleLastErrorCode?: string
  lifecycleLastErrorParams?: Record<string, string | number>
} {
  if (failure === undefined) {
    return {}
  }
  return {
    // The record rejects an empty string; a bare `new Error()` must still record the failure.
    lifecycleLastError: failure ? failure.error || 'Unknown error.' : undefined,
    lifecycleLastErrorCode: failure?.errorCode,
    lifecycleLastErrorParams: failure?.errorParams
  }
}

/** Only the coded fields, for spreading next to an existing English `error`. */
export function pickEphemeralVmFailureCode(
  failure: Partial<EphemeralVmFailure>
): Pick<EphemeralVmFailure, 'errorCode' | 'errorParams'> {
  return {
    ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
    ...(failure.errorParams ? { errorParams: failure.errorParams } : {})
  }
}
