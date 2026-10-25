import type { GitStatusEntry } from './git-status-types'
import { decodeGitCQuotedPath } from './git-cquoted-path'

/** Parse porcelain v2 incrementally so callers can stop Git at the entry limit instead of buffering output past V8’s string ceiling.
 * Carry partial newline-delimited records between chunks. Defer unmerged u rows to caller resolution (using mW presence), but count them toward the cap. */
export type BranchMetadata = {
  head?: string
  branch?: string
  upstreamName?: string
  upstreamAheadBehind?: { ahead: number; behind: number }
}

export type StatusPorcelainRecord =
  | { type: 'entry'; entry: GitStatusEntry }
  | { type: 'unmerged'; line: string }

export class StatusPorcelainParser {
  private carry = ''
  private count = 0

  readonly entries: GitStatusEntry[] = []
  readonly ignoredPaths: string[] = []
  /** Raw `u ` lines for the caller to resolve asynchronously. */
  readonly unmergedLines: string[] = []
  /** Changed records in Git's output order, including deferred unmerged rows. */
  readonly statusRecords: StatusPorcelainRecord[] = []
  readonly branch: BranchMetadata = {}

  /** Total changed-file entries observed (including any past the limit). */
  get statusLength(): number {
    return this.count
  }

  /** Parse complete lines, carrying any trailing fragment. Return true past the changed-entry limit so callers stop Git; zero disables the cap. */
  update(chunk: string, limit: number): boolean {
    const text = this.carry + chunk
    let start = 0
    while (true) {
      const nl = text.indexOf('\n', start)
      if (nl === -1) {
        break
      }
      // Strip a trailing \r so Windows CRLF output parses cleanly.
      let end = nl
      if (end > start && text.charCodeAt(end - 1) === 13) {
        end -= 1
      }
      this.parseLine(text.slice(start, end))
      start = nl + 1
      if (limit !== 0 && this.count > limit) {
        this.carry = ''
        return true
      }
    }
    this.carry = text.slice(start)
    return false
  }

  /** Flush a final line with no trailing newline (e.g. when git exits). */
  finish(): void {
    if (this.carry.length > 0) {
      this.parseLine(this.carry)
      this.carry = ''
    }
  }

  private parseLine(line: string): void {
    if (!line) {
      return
    }
    if (line.startsWith('# branch.oid ')) {
      this.branch.head = line.slice('# branch.oid '.length).trim()
      return
    }
    if (line.startsWith('# branch.head ')) {
      const branchHead = line.slice('# branch.head '.length).trim()
      // Undefined preserves transport compatibility and lets renderer clear detached-HEAD branch state.
      this.branch.branch =
        branchHead && branchHead !== '(detached)' ? `refs/heads/${branchHead}` : undefined
      return
    }
    if (line.startsWith('# branch.upstream ')) {
      this.branch.upstreamName = line.slice('# branch.upstream '.length).trim() || undefined
      return
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      if (match) {
        this.branch.upstreamAheadBehind = {
          ahead: Number.parseInt(match[1], 10),
          behind: Number.parseInt(match[2], 10)
        }
      }
      return
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      this.parseChangedEntry(line)
      return
    }
    if (line.startsWith('? ')) {
      this.push({
        path: decodeGitCQuotedPath(line.slice(2)),
        status: 'untracked',
        area: 'untracked'
      })
      return
    }
    if (line.startsWith('! ')) {
      this.ignoredPaths.push(decodeGitCQuotedPath(line.slice(2)))
      return
    }
    if (line.startsWith('u ')) {
      this.count += 1
      this.unmergedLines.push(line)
      this.statusRecords.push({ type: 'unmerged', line })
    }
  }

  private parseChangedEntry(line: string): void {
    // Changed entries: "1 XY sub mH mI mW hH path" or
    // "2 XY sub mH mI mW hH X<score> path\torigPath"
    const parts = line.split(' ')
    const xy = parts[1]
    const indexStatus = xy[0]
    const worktreeStatus = xy[1]

    if (line.startsWith('2 ')) {
      // Type-2 paths follow nine fixed fields, with oldPath after TAB; retain spaces for row actions and numstat keys.
      const tabParts = line.split('\t')
      const path = decodeGitCQuotedPath(tabParts[0].split(' ').slice(9).join(' '))
      const oldPath = decodeGitCQuotedPath(tabParts.slice(1).join('\t'))
      if (indexStatus !== '.') {
        this.push({
          path,
          status: parseStatusChar(indexStatus),
          area: 'staged',
          oldPath,
          ...submoduleStatusField(parts[2], indexStatus)
        })
      }
      if (worktreeStatus !== '.') {
        this.push({
          path,
          status: parseStatusChar(worktreeStatus),
          area: 'unstaged',
          oldPath,
          ...submoduleStatusField(parts[2], worktreeStatus)
        })
      }
      return
    }

    const path = decodeGitCQuotedPath(parts.slice(8).join(' '))
    if (indexStatus !== '.') {
      this.push({
        path,
        status: parseStatusChar(indexStatus),
        area: 'staged',
        ...submoduleStatusField(parts[2], indexStatus)
      })
    }
    if (worktreeStatus !== '.') {
      this.push({
        path,
        status: parseStatusChar(worktreeStatus),
        area: 'unstaged',
        ...submoduleStatusField(parts[2], worktreeStatus)
      })
    }
  }

  private push(entry: GitStatusEntry): void {
    this.count += 1
    this.entries.push(entry)
    this.statusRecords.push({ type: 'entry', entry })
  }
}

export function parseStatusChar(char: string): GitStatusEntry['status'] {
  switch (char) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

export function parseSubmoduleStatus(
  submoduleField: string | undefined,
  statusChar = '.'
): GitStatusEntry['submodule'] {
  if (!submoduleField?.startsWith('S')) {
    return undefined
  }
  return {
    commitChanged: submoduleField[1] === 'C' || (submoduleField === 'S...' && statusChar === 'M'),
    trackedChanges: submoduleField[2] === 'M',
    untrackedChanges: submoduleField[3] === 'U'
  }
}

function submoduleStatusField(
  submoduleField: string | undefined,
  statusChar: string
): { submodule: GitStatusEntry['submodule'] } | {} {
  const submodule = parseSubmoduleStatus(submoduleField, statusChar)
  return submodule ? { submodule } : {}
}
