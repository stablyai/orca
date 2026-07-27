// Why: fork PR/MR heads live on the hosting remote (almost always `origin`);
// picking an arbitrary first remote (e.g. a contributor `fork`) fetches the
// wrong object. Prefer origin, then a lone remote, else refuse to guess.
export function pickPreferredGitRemote(remotes: readonly string[]): string {
  const cleaned = remotes.map((line) => line.trim()).filter(Boolean)
  if (cleaned.includes('origin')) {
    return 'origin'
  }
  if (cleaned.length === 1) {
    return cleaned[0]!
  }
  if (cleaned.length === 0) {
    throw new Error('Repo has no configured git remotes.')
  }
  throw new Error(`Repo has multiple remotes (${cleaned.join(', ')}) and no default is configured.`)
}
