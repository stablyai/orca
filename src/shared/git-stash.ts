export const GIT_STASH_RUNTIME_CAPABILITY = 'git.stash.v1' as const

export type GitStashSummary = {
  ref: string
  commitId: string
  author: string
  email: string
  timestamp: number
  summary: string
}

export type GitStashFile = {
  path: string
  oldPath?: string
  status: string
  commitId?: string
}

export type GitStashCreateOptions = {
  message?: string
  includeUntracked?: boolean
  keepIndex?: boolean
}

export function parseGitStashList(output: string): GitStashSummary[] {
  return output
    .split('\n')
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => {
      const [ref = '', commitId = '', author = '', email = '', timestamp = '0', summary = ''] =
        line.split('\0')
      return { ref, commitId, author, email, timestamp: Number(timestamp) || 0, summary }
    })
    .filter((stash) => isGitStashRef(stash.ref) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(stash.commitId))
}

export function parseGitStashFiles(output: string): GitStashFile[] {
  const fields = output.split('\0')
  const files: GitStashFile[] = []
  for (let index = 0; index < fields.length && files.length < 2000; ) {
    const status = fields[index++]
    if (!status) {
      continue
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = fields[index++]
      const path = fields[index++]
      if (oldPath && path) {
        files.push({ status, oldPath, path })
      }
    } else {
      const path = fields[index++]
      if (path) {
        files.push({ status, path })
      }
    }
  }
  return files
}

export function isGitStashRef(value: string): boolean {
  return /^stash@\{\d+\}$/.test(value)
}
