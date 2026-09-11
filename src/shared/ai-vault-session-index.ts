import type {
  AiVaultAgent,
  AiVaultSession,
  AiVaultSessionHost,
  AiVaultSessionProjectRef
} from './ai-vault-types'
import { deriveAiVaultSessionHost } from './ai-vault-session-host'
import { sessionPreviewSearchText } from './ai-vault-session-preview-text'
import { tokenizeIndexText } from './ai-vault-session-query'
import { folderLabel } from './ai-vault-session-groups'

export type AiVaultIndexedSession = {
  id: string
  revision: string
  agent: AiVaultAgent
  host: AiVaultSessionHost
  messageCount: number
  updatedAtMs: number
  createdAtMs: number
  model: string
  branch: string
  cwd: string
  filePath: string
  projectKey: string | null
  repoLabel: string
  searchable: string
  titleSearchable: string
  summarySearchable: string
  tokens: readonly string[]
}

export type AiVaultSessionIndexMaps = {
  sessionProjectById?: ReadonlyMap<string, AiVaultSessionProjectRef>
  projectLabelByKey?: ReadonlyMap<string, string>
}

export type AiVaultIndexQueryMode = 'and' | 'or'

export function parseSessionTimestampMs(
  primary: string | null | undefined,
  fallback: string | null | undefined
): number {
  const parsedPrimary = primary ? Date.parse(primary) : Number.NaN
  if (Number.isFinite(parsedPrimary)) {
    return parsedPrimary
  }
  const parsedFallback = fallback ? Date.parse(fallback) : Number.NaN
  return Number.isFinite(parsedFallback) ? parsedFallback : 0
}

export class AiVaultSessionSearchIndex {
  private readonly documents = new Map<string, AiVaultIndexedSession>()
  private readonly postings = new Map<string, Set<string>>()

  get size(): number {
    return this.documents.size
  }

  get(id: string): AiVaultIndexedSession | undefined {
    return this.documents.get(id)
  }

  ids(): string[] {
    return [...this.documents.keys()]
  }

  upsert(session: AiVaultSession, maps: AiVaultSessionIndexMaps = {}): boolean {
    const next = buildIndexedSession(session, maps)
    const current = this.documents.get(session.id)
    if (current?.revision === next.revision) {
      return false
    }
    if (current) {
      this.unindex(current)
    }
    this.documents.set(session.id, next)
    this.index(next)
    return true
  }

  remove(id: string): boolean {
    const current = this.documents.get(id)
    if (!current) {
      return false
    }
    this.unindex(current)
    this.documents.delete(id)
    return true
  }

  sync(sessions: readonly AiVaultSession[], maps: AiVaultSessionIndexMaps = {}): void {
    const seen = new Set<string>()
    for (const session of sessions) {
      seen.add(session.id)
      this.upsert(session, maps)
    }
    for (const id of this.ids()) {
      if (!seen.has(id)) {
        this.remove(id)
      }
    }
  }

  query(terms: readonly string[], mode: AiVaultIndexQueryMode = 'and'): Set<string> | null {
    const tokens = uniqueIndexTokens(terms)
    if (tokens.length === 0) {
      return null
    }
    if (mode === 'or') {
      const union = new Set<string>()
      for (const token of tokens) {
        const posting = this.postings.get(token)
        if (!posting) {
          continue
        }
        for (const id of posting) {
          union.add(id)
        }
      }
      return union
    }
    let intersection: Set<string> | null = null
    for (const token of tokens) {
      const posting = this.postings.get(token)
      if (!posting) {
        return new Set()
      }
      intersection = intersection ? intersectIds(intersection, posting) : new Set(posting)
    }
    return intersection ?? new Set()
  }

  private index(document: AiVaultIndexedSession): void {
    for (const token of document.tokens) {
      let posting = this.postings.get(token)
      if (!posting) {
        posting = new Set()
        this.postings.set(token, posting)
      }
      posting.add(document.id)
    }
  }

  private unindex(document: AiVaultIndexedSession): void {
    for (const token of document.tokens) {
      const posting = this.postings.get(token)
      if (!posting) {
        continue
      }
      posting.delete(document.id)
      if (posting.size === 0) {
        this.postings.delete(token)
      }
    }
  }
}

export function sessionIndexRevision(session: AiVaultSession): string {
  // Why: node:sqlite TEXT is C-string based, so a NUL separator would truncate
  // the durable revision and force a rewrite on every sync.
  return [session.modifiedAt, session.updatedAt ?? '', session.messageCount, session.title].join(
    '\t'
  )
}

function buildIndexedSession(
  session: AiVaultSession,
  maps: AiVaultSessionIndexMaps
): AiVaultIndexedSession {
  const sessionProject = maps.sessionProjectById?.get(session.id)
  const repoLabel = (
    sessionProject?.kind === 'repo'
      ? (maps.projectLabelByKey?.get(sessionProject.key) ?? sessionProject.label)
      : folderLabel(session.cwd)
  ).toLowerCase()
  const searchable = [
    session.title,
    session.sessionId,
    session.agent,
    session.branch,
    session.model,
    session.cwd,
    session.filePath,
    sessionPreviewSearchText(session),
    repoLabel
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return {
    id: session.id,
    revision: sessionIndexRevision(session),
    agent: session.agent,
    host: deriveAiVaultSessionHost(session),
    messageCount: session.messageCount,
    updatedAtMs: parseSessionTimestampMs(session.updatedAt, session.modifiedAt),
    createdAtMs: parseSessionTimestampMs(session.createdAt, session.modifiedAt),
    model: (session.model ?? '').toLowerCase(),
    branch: (session.branch ?? '').toLowerCase(),
    cwd: session.cwd ?? '',
    filePath: session.filePath,
    projectKey: sessionProject?.key ?? null,
    repoLabel,
    searchable,
    titleSearchable: session.title.toLowerCase(),
    summarySearchable: sessionPreviewSearchText(session).toLowerCase(),
    tokens: uniqueIndexTokens(tokenizeIndexText(searchable))
  }
}

function uniqueIndexTokens(terms: readonly string[]): string[] {
  const tokens: string[] = []
  for (const term of terms) {
    for (const token of tokenizeIndexText(term)) {
      if (!tokens.includes(token)) {
        tokens.push(token)
      }
    }
  }
  return tokens
}

function intersectIds(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  const result = new Set<string>()
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left]
  for (const id of smaller) {
    if (larger.has(id)) {
      result.add(id)
    }
  }
  return result
}
