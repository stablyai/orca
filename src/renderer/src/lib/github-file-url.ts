type GitHubFileUrlInput = {
  originRemoteUrl: string | undefined
  branch: string | undefined
  filePath: string
}

function parseGitHubRepository(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim()
  const scpMatch = trimmed.includes('://') ? null : /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(trimmed)
  let host: string
  let repositoryPath: string

  if (scpMatch) {
    host = scpMatch[1] ?? ''
    repositoryPath = scpMatch[2] ?? ''
  } else {
    try {
      const parsed = new URL(trimmed)
      host = parsed.hostname
      repositoryPath = parsed.pathname
    } catch {
      return null
    }
  }

  if (host.toLowerCase() !== 'github.com') {
    return null
  }
  const segments = repositoryPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/')
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null
  }
  return segments.map(encodeURIComponent).join('/')
}

function encodeGitHubPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function buildGitHubFileUrl(input: GitHubFileUrlInput): string | null {
  if (!input.originRemoteUrl || !input.branch || !input.filePath) {
    return null
  }
  const repository = parseGitHubRepository(input.originRemoteUrl)
  if (!repository) {
    return null
  }
  const branch = input.branch.replace(/^refs\/heads\//, '')
  if (!branch) {
    return null
  }
  return `https://github.com/${repository}/blob/${encodeGitHubPath(branch)}/${encodeGitHubPath(input.filePath)}`
}
