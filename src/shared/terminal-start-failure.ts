import type { TerminalExitCause } from './terminal-exit-cause'

export type TerminalStartFailure = { cause: TerminalExitCause; incarnationId?: string }

export function withInitialOutputDiagnostic(
  cause: TerminalExitCause,
  detected: boolean
): TerminalExitCause {
  return detected && cause.kind === 'exited' && cause.exitCode > 0
    ? { ...cause, initialOutputDiagnostic: 'git-bash-console-capacity' }
    : cause
}

/** Only the allowlisted observation crosses error envelopes; never arbitrary terminal output. */
export function parseTerminalStartFailure(value: unknown): TerminalStartFailure | undefined {
  if (typeof value !== 'object' || value === null || !('cause' in value)) {
    return undefined
  }
  const cause = value.cause
  if (
    typeof cause !== 'object' ||
    cause === null ||
    !('kind' in cause) ||
    cause.kind !== 'exited' ||
    !('exitCode' in cause) ||
    typeof cause.exitCode !== 'number' ||
    !Number.isFinite(cause.exitCode) ||
    cause.exitCode <= 0 ||
    !('initialOutputDiagnostic' in cause) ||
    cause.initialOutputDiagnostic !== 'git-bash-console-capacity'
  ) {
    return undefined
  }
  return {
    cause: {
      kind: 'exited',
      exitCode: cause.exitCode,
      initialOutputDiagnostic: cause.initialOutputDiagnostic
    },
    ...('incarnationId' in value && typeof value.incarnationId === 'string'
      ? { incarnationId: value.incarnationId }
      : {})
  }
}

export function terminalStartError(
  message: string,
  cause?: TerminalExitCause | null,
  incarnationId?: string
): Error {
  return Object.assign(new Error(message), { terminalStartFailure: { cause, incarnationId } })
}

export function terminalExitError(
  message: string,
  cause?: TerminalExitCause | null,
  incarnationId?: string
): Error {
  return Object.assign(new Error(message), {
    terminalExitCause: cause,
    ...(incarnationId ? { terminalExitIncarnationId: incarnationId } : {})
  })
}

/** Classify a newly produced creation failure before sharing it with other requests. */
export function classifyTerminalCreationFailure(
  error: unknown,
  result:
    | {
        id: string
        incarnationId?: string
        isReattach?: boolean
        agentSessionEnsure?: { disposition: string }
      }
    | undefined
): unknown {
  if (
    !result?.id ||
    result.isReattach ||
    result.agentSessionEnsure?.disposition === 'adopted' ||
    readTerminalStartFailure(error) ||
    !(error instanceof Error) ||
    !('terminalExitCause' in error)
  ) {
    return error
  }
  const failure = parseTerminalStartFailure({
    cause: error.terminalExitCause,
    incarnationId:
      'terminalExitIncarnationId' in error ? error.terminalExitIncarnationId : result.incarnationId
  })
  if (!failure || (failure.incarnationId && failure.incarnationId !== result.incarnationId)) {
    return error
  }
  return Object.defineProperties(new Error(error.message), {
    ...Object.getOwnPropertyDescriptors(error),
    stack: { value: error.stack, configurable: true, writable: true },
    terminalStartFailure: { value: failure, enumerable: true, configurable: true, writable: true }
  })
}

export function readTerminalStartFailure(error: unknown): TerminalStartFailure | undefined {
  const seen = new Set<unknown>()
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    if ('terminalStartFailure' in error) {
      const detail = parseTerminalStartFailure(error.terminalStartFailure)
      if (detail) {
        return detail
      }
    }
    error = error.cause
  }
  return undefined
}

export function formatTerminalStartFailure(
  error: unknown,
  subject = 'the terminal'
): string | undefined {
  if (!readTerminalStartFailure(error)) {
    return undefined
  }
  const uncertain = error instanceof Error && error.message === 'agent_session_operation_unknown'
  return `${uncertain ? `Couldn't confirm ${subject} started. ` : ''}Git Bash reported its limit of 128 open terminals on this PC while starting ${subject}. Close some Git Bash terminals and try again.`
}
