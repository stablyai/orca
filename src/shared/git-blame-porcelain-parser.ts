import type { GitBlameCommit, GitBlameHunk, GitBlameResult } from './git-blame-types'

const HEADER_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/
const UNCOMMITTED_SHA_PATTERN = /^0+$/

function emptyCommit(sha: string): GitBlameCommit {
  return {
    sha,
    author: '',
    authorEmail: '',
    authorTime: 0,
    summary: '',
    uncommitted: UNCOMMITTED_SHA_PATTERN.test(sha)
  }
}

/** Parses `git blame --porcelain` output into per-commit metadata and line ranges. */
export function parseGitBlamePorcelain(stdout: string): GitBlameResult {
  const commits: Record<string, GitBlameCommit> = {}
  const hunks: GitBlameHunk[] = []
  let current: GitBlameCommit | null = null

  for (const line of stdout.split('\n')) {
    if (line.startsWith('\t')) {
      continue
    }
    const header = HEADER_PATTERN.exec(line)
    if (header) {
      const sha = header[1]
      const finalLine = Number(header[2])
      current = commits[sha] ?? (commits[sha] = emptyCommit(sha))
      const last = hunks.at(-1)
      if (last && last.sha === sha && last.startLine + last.lineCount === finalLine) {
        last.lineCount += 1
      } else {
        hunks.push({ sha, startLine: finalLine, lineCount: 1 })
      }
      continue
    }
    if (!current) {
      continue
    }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    switch (key) {
      case 'author':
        current.author = value
        break
      case 'author-mail':
        current.authorEmail = value.replace(/^<|>$/g, '')
        break
      case 'author-time':
        current.authorTime = Number(value) * 1000 || 0
        break
      case 'summary':
        current.summary = value
        break
    }
  }

  // Why: lookups binary-search by line; don't depend on git's emit order.
  hunks.sort((a, b) => a.startLine - b.startLine)
  return { commits, hunks }
}

/** Binary-searches the hunk covering a 1-based line. */
export function findGitBlameHunkForLine(
  hunks: readonly GitBlameHunk[],
  line: number
): GitBlameHunk | null {
  let low = 0
  let high = hunks.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const hunk = hunks[mid]
    if (line < hunk.startLine) {
      high = mid - 1
    } else if (line >= hunk.startLine + hunk.lineCount) {
      low = mid + 1
    } else {
      return hunk
    }
  }
  return null
}
