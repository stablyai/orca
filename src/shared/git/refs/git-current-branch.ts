export async function getGitCurrentBranchName(
  runGit: (args: string[]) => Promise<{ stdout: string }>
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['symbolic-ref', '--quiet', 'HEAD'])
    const ref = stdout.trim()
    const prefix = 'refs/heads/'
    return ref.startsWith(prefix) ? ref.slice(prefix.length) || null : null
  } catch {
    return null
  }
}
