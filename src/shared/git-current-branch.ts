import type { GitCommandRunner } from './git-effective-upstream'

export async function readCurrentGitBranchName(runGit: GitCommandRunner): Promise<string | null> {
  try {
    const { stdout } = await runGit(['symbolic-ref', '--quiet', 'HEAD'])
    const refName = stdout.trim()
    const prefix = 'refs/heads/'
    // Short symbolic names are display spellings and can name another branch's config.
    return refName.startsWith(prefix) ? refName.slice(prefix.length) || null : null
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 1) {
      return null
    }
    throw error
  }
}
