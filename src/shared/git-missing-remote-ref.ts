export function isMissingRemoteRefGitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return (
    normalized.includes('could not find remote ref') ||
    normalized.includes("couldn't find remote ref")
  )
}
