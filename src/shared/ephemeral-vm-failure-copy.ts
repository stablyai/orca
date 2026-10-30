// One English table for ephemeral VM failures: main builds the wire/persisted English, the renderer translates by code.
export const EPHEMERAL_VM_FAILURE_COPY = {
  repoNotFound: 'Repo not found: {{repoId}}',
  remoteRepoUnsupported: 'Ephemeral VM recipes run on the local desktop host in v1.',
  recipeNotFound: 'Recipe not found: {{recipeId}}',
  runtimeNotFound: 'Unknown ephemeral VM runtime: {{runtimeId}}',
  runtimeRepoMissing: 'Ephemeral VM runtime has no repo id: {{runtimeId}}',
  provisionCancelled: 'Provisioning cancelled.',
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
    /\{\{(repoId|recipeId|runtimeId|ref|exitCode)\}\}/g,
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

export function ephemeralVmExitFailure(
  step: 'recipe' | 'destroy',
  exitCode: number | null
): EphemeralVmFailure {
  if (step === 'recipe') {
    return exitCode === null
      ? ephemeralVmFailure('recipeExitedWithoutCode')
      : ephemeralVmFailure('recipeExited', { exitCode })
  }
  return exitCode === null
    ? ephemeralVmFailure('destroyExitedWithoutCode')
    : ephemeralVmFailure('destroyExited', { exitCode })
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

/** Only the coded fields, for spreading next to an existing English `error`. */
export function pickEphemeralVmFailureCode(
  failure: Partial<EphemeralVmFailure>
): Pick<EphemeralVmFailure, 'errorCode' | 'errorParams'> {
  return {
    ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
    ...(failure.errorParams ? { errorParams: failure.errorParams } : {})
  }
}
