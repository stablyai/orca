import type { ConversationKnowledgeGraphNode } from '../../../shared/conversation-knowledge-graph'

type SourceBackedFilters = {
  reliability?: 'user-confirmed' | 'verified' | 'inferred' | 'proposal'
  kind?: 'decision' | 'constraint' | 'progress' | 'open-loop'
  lifecycle?: 'active' | 'superseded' | 'conflicted' | 'expired'
}

export function parseSourceBackedFilters(query: string): {
  filters: SourceBackedFilters
  tokens: string[]
} {
  const filters: SourceBackedFilters = {}
  const tokens: string[] = []
  for (const token of normalizeQuery(query)) {
    const [key, value] = token.split(':', 2)
    if (key === 'reliability' && isHandoffReliability(value)) {
      filters.reliability = value
    } else if (key === 'kind' && isHandoffKind(value)) {
      filters.kind = value
    } else if (key === 'lifecycle' && isHandoffLifecycle(value)) {
      filters.lifecycle = value
    } else {
      tokens.push(token)
    }
  }
  return { filters, tokens }
}

export function hasSourceBackedFilters(filters: SourceBackedFilters): boolean {
  return (
    filters.reliability !== undefined ||
    filters.kind !== undefined ||
    filters.lifecycle !== undefined
  )
}

export function matchesSourceBackedFilters(
  node: ConversationKnowledgeGraphNode,
  filters: SourceBackedFilters
): boolean {
  const sourceBacked = node.sourceBacked
  return (
    sourceBacked !== undefined &&
    (filters.reliability === undefined || sourceBacked.reliability === filters.reliability) &&
    (filters.kind === undefined || sourceBacked.kind === filters.kind) &&
    (filters.lifecycle === undefined ||
      (sourceBacked.lifecycle?.status ?? 'active') === filters.lifecycle)
  )
}

function normalizeQuery(query: string): string[] {
  return query
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

function isHandoffReliability(
  value: string | undefined
): value is SourceBackedFilters['reliability'] {
  return (
    value === 'user-confirmed' ||
    value === 'verified' ||
    value === 'inferred' ||
    value === 'proposal'
  )
}

function isHandoffKind(value: string | undefined): value is SourceBackedFilters['kind'] {
  return (
    value === 'decision' || value === 'constraint' || value === 'progress' || value === 'open-loop'
  )
}

function isHandoffLifecycle(value: string | undefined): value is SourceBackedFilters['lifecycle'] {
  return (
    value === 'active' || value === 'superseded' || value === 'conflicted' || value === 'expired'
  )
}
