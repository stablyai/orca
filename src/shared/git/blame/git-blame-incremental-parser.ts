import type { GitBlameCommit } from './git-blame-types'

const RECORD_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+) (\d+)$/

type ParsedBlame = { commits: GitBlameCommit[]; ranges: number[] }

/** Parse `git blame --incremental`; commit headers appear only on a commit's first record. */
export function parseGitBlameIncremental(output: string): ParsedBlame {
  const commits: GitBlameCommit[] = []
  const commitIndexByOid = new Map<string, number>()
  const records: [start: number, count: number, commitIndex: number][] = []
  let current: GitBlameCommit | undefined
  let currentStart = 0
  let currentCount = 0

  for (const line of output.split('\n')) {
    if (!current) {
      const header = RECORD_HEADER.exec(line)
      if (!header) {
        continue
      }
      const oid = header[1]
      const index = commitIndexByOid.get(oid)
      current =
        index === undefined
          ? { oid, author: '', authorEmail: '', authorTime: 0, summary: '' }
          : commits[index]
      if (index === undefined) {
        commitIndexByOid.set(oid, commits.length)
        commits.push(current)
      }
      currentStart = Number(header[2])
      currentCount = Number(header[3])
      continue
    }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'author') {
      current.author = value
    } else if (key === 'author-mail') {
      current.authorEmail = value.replace(/^<|>$/g, '')
    } else if (key === 'author-time') {
      current.authorTime = Number(value) * 1000
    } else if (key === 'summary') {
      current.summary = value
    } else if (key === 'filename') {
      records.push([currentStart, currentCount, commitIndexByOid.get(current.oid)!])
      current = undefined
    }
  }

  records.sort((a, b) => a[0] - b[0])
  return { commits, ranges: records.flat() }
}
