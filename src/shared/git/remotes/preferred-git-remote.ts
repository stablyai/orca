// Fetch fork PR/MR heads from hosting origin; otherwise accept only a lone remote rather than guessing a contributor fork.
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
