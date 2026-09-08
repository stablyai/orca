import { isSafeGitRefName } from './git-status-upstream-ref'

type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

function refspecMatch(pattern: string, ref: string): string | null {
  const parts = pattern.split('*')
  if (parts.length === 1) {
    return pattern === ref ? '' : null
  }
  if (parts.length !== 2 || !ref.startsWith(parts[0]!) || !ref.endsWith(parts[1]!)) {
    return null
  }
  return ref.length >= parts[0]!.length + parts[1]!.length
    ? ref.slice(parts[0]!.length, ref.length - parts[1]!.length)
    : null
}

function isMissingTrackingRef(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const candidate = error as Error & { code?: unknown; stderr?: unknown }
  if (typeof candidate.stderr === 'string' && candidate.stderr.trim()) {
    return false
  }
  return candidate.code === 1 || /(?:exited with|exit code) 1\b/i.test(candidate.message)
}

async function resolveAbbreviatedFetchSource(
  runGit: GitCommandRunner,
  remote: string,
  abbreviation: string,
  source: string
): Promise<boolean> {
  // Git remote.c chooses the highest-ranked refname_match, including tags before heads.
  const candidates = [
    abbreviation,
    `refs/${abbreviation}`,
    `refs/tags/${abbreviation}`,
    `refs/heads/${abbreviation}`,
    `refs/remotes/${abbreviation}`,
    `refs/remotes/${abbreviation}/HEAD`
  ]
  if (!candidates.includes(source)) {
    return false
  }
  try {
    const { stdout } = await runGit(['ls-remote', '--refs', '--', remote, ...candidates])
    const refs = new Set(stdout.split(/\r?\n/).map((line) => line.split('\t')[1]))
    return candidates.find((candidate) => refs.has(candidate)) === source
  } catch {
    return false
  }
}

// Only configured fetch destinations establish tracking authority, regardless of namespace.
export async function readGitRemoteTrackingRef(
  runGit: GitCommandRunner,
  remote: string,
  branch: string,
  options: { requireExisting?: boolean } = {}
): Promise<string | null> {
  let stdout: string
  try {
    ;({ stdout } = await runGit(['config', '--get-all', `remote.${remote}.fetch`]))
  } catch (error) {
    if (isMissingTrackingRef(error)) {
      return null
    }
    throw error
  }
  const source = `refs/heads/${branch}`
  const specs = stdout.trim().split(/\r?\n/)
  if (specs.some((spec) => spec.startsWith('^') && refspecMatch(spec.slice(1), source) !== null)) {
    return null
  }
  for (const spec of specs) {
    const [from, to, extra] = spec.replace(/^\+/, '').split(':')
    if (!from || !to || extra !== undefined) {
      continue
    }
    const match =
      refspecMatch(from, source) ??
      (!from.includes('*') &&
      !from.startsWith('refs/') &&
      (await resolveAbbreviatedFetchSource(runGit, remote, from, source))
        ? ''
        : null)
    if (match === null || from.includes('*') !== to.includes('*') || to.split('*').length > 2) {
      continue
    }
    const destination = to.replace('*', () => match)
    const ref = destination.startsWith('refs/')
      ? destination
      : /^(heads|tags|remotes)\//.test(destination)
        ? `refs/${destination}`
        : `refs/heads/${destination}`
    if (!isSafeGitRefName(ref)) {
      continue
    }
    if (options.requireExisting === false) {
      return ref
    }
    try {
      await runGit(['rev-parse', '--verify', '--quiet', ref])
      return ref
    } catch (error) {
      if (isMissingTrackingRef(error)) {
        return null
      }
      throw error
    }
  }
  return null
}
