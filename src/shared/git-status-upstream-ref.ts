const REF_PREFIX = 'refs/'
const LOCAL_BRANCH_REF_PREFIX = 'refs/heads/'
const WORKTREE_REF_PREFIXES = ['refs/bisect/', 'refs/rewritten/', 'refs/worktree/']
const FORBIDDEN_REF_CHARS = '~^:?*[\\'

function hasForbiddenRefChar(ref: string): boolean {
  for (const char of ref) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f || FORBIDDEN_REF_CHARS.includes(char)) {
      return true
    }
  }
  return false
}

export function isSafeGitRefName(ref: string): boolean {
  if (!ref.startsWith(REF_PREFIX) || ref.endsWith('/')) {
    return false
  }
  if (ref.includes('..') || ref.includes('@{') || hasForbiddenRefChar(ref)) {
    return false
  }
  const parts = ref.split('/')
  return (
    parts.length >= 2 &&
    parts.every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !part.startsWith('.') &&
        !part.endsWith('.') &&
        !part.endsWith('.lock')
    )
  )
}

export function isSafeGitStatusUpstreamRef(ref: string): boolean {
  return (
    isSafeGitRefName(ref) &&
    ref !== 'refs/heads' &&
    !ref.startsWith(LOCAL_BRANCH_REF_PREFIX) &&
    !WORKTREE_REF_PREFIXES.some((prefix) => ref === prefix.slice(0, -1) || ref.startsWith(prefix))
  )
}
