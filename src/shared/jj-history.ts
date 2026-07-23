import type { GitBranchChangeEntry } from './types'
import {
  GIT_HISTORY_DEFAULT_LIMIT,
  GIT_HISTORY_MAX_LIMIT,
  type GitHistoryExecutor,
  type GitHistoryItem,
  type GitHistoryItemRef,
  type GitHistoryOptions,
  type GitHistoryResult
} from './git-history-types'

const JJ_HISTORY_RECORD_SEPARATOR = '\0'
const JJ_HISTORY_FIELD_SEPARATOR = '\x1f'
const JJ_HISTORY_DEFAULT_REVSET = 'present(@) | ancestors(immutable_heads().., 2) | trunk()'
const JJ_HISTORY_TEMPLATE = [
  'json(self)',
  'json(bookmarks)',
  'json(current_working_copy)',
  'json(immutable)',
  'json(empty)',
  'json(conflict)',
  'self.diff().summary()'
].join(` ++ "${JJ_HISTORY_FIELD_SEPARATOR}" ++ `)

type JjCommitRef = {
  name?: unknown
  remote?: unknown
}

type JjCommitRecord = {
  commit_id?: unknown
  parents?: unknown
  change_id?: unknown
  description?: unknown
  author?: unknown
}

type JjAuthor = {
  name?: unknown
  email?: unknown
  timestamp?: unknown
}

function clampHistoryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return GIT_HISTORY_DEFAULT_LIMIT
  }
  return Math.min(
    GIT_HISTORY_MAX_LIMIT,
    Math.max(1, Math.trunc(limit ?? GIT_HISTORY_DEFAULT_LIMIT))
  )
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0]?.trim() || '(no description set)'
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function parseBoolean(raw: string): boolean {
  return raw.trim() === 'true'
}

function parseJjJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function parseParents(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((parent): parent is string => typeof parent === 'string' && parent.length > 0)
}

function parseAuthor(value: unknown): {
  author?: string
  authorEmail?: string
  timestamp?: number
} {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const author = value as JjAuthor
  return {
    ...(typeof author.name === 'string' && author.name ? { author: author.name } : {}),
    ...(typeof author.email === 'string' && author.email ? { authorEmail: author.email } : {}),
    ...(parseTimestamp(author.timestamp) !== undefined
      ? { timestamp: parseTimestamp(author.timestamp) }
      : {})
  }
}

function parseJjBookmarks(raw: string, revision: string): GitHistoryItemRef[] {
  const refs = parseJjJson<JjCommitRef[]>(raw, [])
  return refs.flatMap((ref): GitHistoryItemRef[] => {
    if (typeof ref.name !== 'string' || !ref.name) {
      return []
    }
    if (typeof ref.remote === 'string' && ref.remote) {
      return [
        {
          id: `jj:remote-bookmark:${ref.remote}/${ref.name}`,
          name: `${ref.remote}/${ref.name}`,
          revision,
          category: 'remote bookmarks'
        }
      ]
    }
    return [
      {
        id: `jj:bookmark:${ref.name}`,
        name: ref.name,
        revision,
        category: 'bookmarks'
      }
    ]
  })
}

function parseJjSummaryLine(line: string): GitBranchChangeEntry | null {
  const match = line.match(/^([A-Z])\s+(.+)$/)
  if (!match) {
    return null
  }
  const marker = match[1]
  const rawPath = match[2].trim()
  if (!rawPath) {
    return null
  }
  if (marker === 'A') {
    return { path: rawPath, status: 'added' }
  }
  if (marker === 'D') {
    return { path: rawPath, status: 'deleted' }
  }
  if (marker === 'R' || marker === 'C') {
    const renameMatch = rawPath.match(/^(.*?)\s+(?:=>|->)\s+(.*)$/)
    const path = renameMatch?.[2]?.trim() || rawPath
    const oldPath = renameMatch?.[1]?.trim()
    return {
      path,
      status: marker === 'R' ? 'renamed' : 'copied',
      ...(oldPath ? { oldPath } : {})
    }
  }
  return { path: rawPath, status: 'modified' }
}

export function parseJjDiffSummary(summary: string): GitBranchChangeEntry[] {
  return summary
    .split(/\r?\n/)
    .map((line) => parseJjSummaryLine(line.trim()))
    .filter((entry): entry is GitBranchChangeEntry => Boolean(entry))
}

export function parseJjHistoryLog(stdout: string): GitHistoryItem[] {
  const items: GitHistoryItem[] = []
  for (const rawRecord of stdout.split(JJ_HISTORY_RECORD_SEPARATOR)) {
    if (!rawRecord.trim()) {
      continue
    }
    const [rawCommit, rawBookmarks, rawCurrent, rawImmutable, rawEmpty, rawConflict, ...summary] =
      rawRecord.split(JJ_HISTORY_FIELD_SEPARATOR)
    const commit = parseJjJson<JjCommitRecord>(rawCommit ?? '', {})
    if (typeof commit.commit_id !== 'string' || !commit.commit_id) {
      continue
    }
    const changeId = typeof commit.change_id === 'string' ? commit.change_id : ''
    const message = typeof commit.description === 'string' ? commit.description.trimEnd() : ''
    const references = parseJjBookmarks(rawBookmarks ?? '[]', commit.commit_id)
    if (parseBoolean(rawCurrent ?? 'false')) {
      references.unshift({
        id: 'jj:working-copy',
        name: '@',
        revision: commit.commit_id,
        category: 'commits'
      })
    }
    if (parseBoolean(rawImmutable ?? 'false')) {
      references.push({
        id: `jj:immutable:${commit.commit_id}`,
        name: '◆',
        revision: commit.commit_id,
        category: 'commits'
      })
    }
    if (parseBoolean(rawConflict ?? 'false')) {
      references.push({
        id: `jj:conflict:${commit.commit_id}`,
        name: 'conflict',
        revision: commit.commit_id,
        category: 'commits'
      })
    }
    if (parseBoolean(rawEmpty ?? 'false')) {
      references.push({
        id: `jj:empty:${commit.commit_id}`,
        name: 'empty',
        revision: commit.commit_id,
        category: 'commits'
      })
    }
    items.push({
      id: commit.commit_id,
      parentIds: parseParents(commit.parents),
      subject: firstLine(message),
      message,
      displayId: shortId(commit.commit_id),
      changeId,
      displayChangeId: changeId ? shortId(changeId) : undefined,
      commitId: commit.commit_id,
      provider: 'jj',
      references,
      fileEntries: parseJjDiffSummary(summary.join(JJ_HISTORY_FIELD_SEPARATOR)),
      ...parseAuthor(commit.author)
    })
  }
  return items
}

export async function loadJjHistoryFromExecutor(
  jj: GitHistoryExecutor,
  cwd: string,
  options: GitHistoryOptions = {}
): Promise<GitHistoryResult> {
  const limit = clampHistoryLimit(options.limit)
  const { stdout } = await jj(
    [
      '--ignore-working-copy',
      'log',
      '--no-graph',
      '--no-pager',
      '--color=never',
      '-r',
      JJ_HISTORY_DEFAULT_REVSET,
      `-n${limit + 1}`,
      '-T',
      `${JJ_HISTORY_TEMPLATE} ++ "${JJ_HISTORY_RECORD_SEPARATOR}"`
    ],
    cwd
  )
  const parsed = parseJjHistoryLog(stdout)
  const items = parsed.slice(0, limit)
  const current = items.find((item) => item.references?.some((ref) => ref.id === 'jj:working-copy'))
  return {
    items,
    provider: 'jj',
    currentRef: current
      ? {
          id: 'jj:working-copy',
          name: '@',
          revision: current.id,
          category: 'commits'
        }
      : undefined,
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: parsed.length > limit,
    limit
  }
}
