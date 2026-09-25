export function deriveCloneRepoNameFromUrl(url: string): string {
  // Why: callers may receive URLs whose default clone folder is "." or "..";
  // rejecting them prevents clone cleanup from escaping the destination.
  const source = url.replace(/\.git\/?$/, '')
  const isWindowsLocalSource = /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\')
  const normalizedSource = isWindowsLocalSource ? source.replace(/\\/g, '/') : source
  const withoutTrailingSeparators = normalizedSource.replace(/\/+$/, '')
  const repoName = withoutTrailingSeparators.split('/').at(-1) ?? ''

  if (
    !repoName ||
    repoName === '.' ||
    repoName === '..' ||
    repoName.includes('/') ||
    repoName.includes('\\') ||
    (isWindowsLocalSource && /^[A-Za-z]:$/.test(repoName))
  ) {
    throw new Error('Invalid repository name derived from URL')
  }
  return repoName
}
