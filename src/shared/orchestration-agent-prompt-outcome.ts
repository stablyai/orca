export class OrchestrationOperationOutcomeUnknownError extends Error {
  readonly code = 'operation_unknown'

  constructor(operation: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`${operation} outcome is unknown: ${reason}`)
    this.name = 'OrchestrationOperationOutcomeUnknownError'
  }
}

export class OrchestrationAgentPromptOutcomeUnknownError extends OrchestrationOperationOutcomeUnknownError {
  constructor(cause: unknown) {
    super('Agent prompt delivery', cause)
    this.name = 'OrchestrationAgentPromptOutcomeUnknownError'
  }
}

export function createOrchestrationOperationCommitTracker(
  operation: string,
  onCommitted?: () => void
): {
  onCommitted: () => void
  rethrowIfCommitted: (error: unknown) => void
} {
  let committed = false
  let commitError: unknown
  return {
    onCommitted: () => {
      if (committed) {
        return
      }
      committed = true
      try {
        onCommitted?.()
      } catch (error) {
        commitError = error
      }
    },
    rethrowIfCommitted: (error) => {
      if (committed) {
        throw new OrchestrationOperationOutcomeUnknownError(operation, commitError ?? error)
      }
    }
  }
}

export function isAgentSessionOperationOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'agentSessionOperationOutcome' in error &&
    error.agentSessionOperationOutcome === 'unknown'
  )
}

export function isOrchestrationOperationOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (isAgentSessionOperationOutcomeUnknown(error) ||
      ('code' in error && error.code === 'operation_unknown'))
  )
}

export function isOrchestrationAgentPromptOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof OrchestrationAgentPromptOutcomeUnknownError ||
    isOrchestrationOperationOutcomeUnknown(error)
  )
}
