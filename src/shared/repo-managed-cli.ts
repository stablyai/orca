export const REPO_CLI_DOWNLOAD_URL = 'https://storage.googleapis.com/git-repo-downloads/repo'
export const REPO_CLI_ORCA_RELATIVE_SEGMENTS = ['.orca', 'bin'] as const

export type RepoCliSource = 'tree' | 'orca' | 'path' | 'missing'

export type RepoCliProbe = {
  available: boolean
  source: RepoCliSource
  program: string | null
  pythonAvailable: boolean
}

export function looksLikeRepoLauncher(content: string): boolean {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('#!') || !trimmed.includes('python')) {
    return false
  }
  return (
    content.includes('gerrit.googlesource.com/git-repo') ||
    content.includes('REPO_REV') ||
    content.includes('git-repo')
  )
}
