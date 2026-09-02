import type { GitStatusEntry } from './git-status-types'
import { decodeGitCQuotedPath } from './git-cquoted-path'

/**
 * Incremental parser for `git status --porcelain=v2 --branch` output.
 *
 * Why incremental: a repo with an enormous un-ignored folder can emit a status
 * listing too large to buffer into one string (it overflows V8's max string
 * length and crashes the process). Feeding chunks here as they arrive lets the
 * caller stop git the moment the changed-entry count crosses a limit, so memory
 * stays bounded. Records are newline-delimited; a partial trailing line is
 * carried across chunks.
 *
 * Sync record types (1/2/?/!) are parsed into `entries`/`ignoredPaths` here.
 * Unmerged (`u`) records need per-file worktree lookups, so their raw lines are
 * collected and resolved by the caller after the stream ends. They still count
 * toward the limit so a conflict-heavy merge cannot bypass the cap.
 */
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
  /** Count of changed-file entries seen — the limit is measured against this. */
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

  /**
   * Feed one decoded chunk. Returns true once the accumulated changed-entry
   * count exceeds `limit` (limit 0 disables the cap), signaling the caller to
   * stop git. Complete lines are parsed; an incomplete trailing line is carried.
   */
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
      // Why: undefined (not '') keeps this transport-compatible — the renderer
      // turns "head without branch" into an explicit detached-HEAD clear.
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
      // Why: porcelain v2 type-2 records put the new path after 9 fixed
      // space-delimited fields and the old path after the tab. Preserving spaces
      // keeps row actions and numstat counts keyed correctly.
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
