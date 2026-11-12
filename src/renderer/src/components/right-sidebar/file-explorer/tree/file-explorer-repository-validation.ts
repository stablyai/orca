/** Validation and failed-attempt backoff are separate; activity cannot freshen another input. */
export function createExplorerRepositoryValidation() {
  let validatedAt = -Infinity
  let retryAt = -Infinity
  return {
    dueAt: (): number => Math.max(validatedAt + 60_000, retryAt),
    settle: (valid: boolean): void => {
      if (valid) {
        validatedAt = Date.now()
        retryAt = -Infinity
      } else {
        retryAt = Date.now() + 60_000
      }
    }
  }
}
