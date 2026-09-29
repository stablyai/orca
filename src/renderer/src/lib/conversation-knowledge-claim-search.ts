import type {
  ConversationKnowledgeHandoffEntry,
  ConversationKnowledgeItem
} from '../../../shared/conversation-knowledge-items'

export type ConversationKnowledgeClaimMatch = {
  item: ConversationKnowledgeItem
  entry: ConversationKnowledgeHandoffEntry
  score: number
}

type ClaimField = 'subject' | 'relation' | 'object' | 'status'
type SearchTerm = { field: ClaimField | null; value: string }

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim()
}

function searchTerms(query: string): SearchTerm[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const separator = token.indexOf(':')
      const field = token.slice(0, separator).toLocaleLowerCase()
      if (separator > 0 && isClaimField(field)) {
        return { field, value: normalized(token.slice(separator + 1)) }
      }
      return { field: null, value: normalized(token) }
    })
    .filter((term) => term.value.length > 0)
}

function isClaimField(value: string): value is ClaimField {
  return value === 'subject' || value === 'relation' || value === 'object' || value === 'status'
}

function fieldValue(entry: ConversationKnowledgeHandoffEntry, field: ClaimField): string {
  return field === 'status' ? (entry.lifecycle?.status ?? 'active') : (entry.claim?.[field] ?? '')
}

function claimScore(
  entry: ConversationKnowledgeHandoffEntry,
  terms: readonly SearchTerm[]
): number | null {
  let score = 0
  for (const term of terms) {
    if (term.field) {
      const value = normalized(fieldValue(entry, term.field))
      if (!value.includes(term.value)) {
        return null
      }
      score += value === term.value ? 12 : 8
      continue
    }
    const fields = [entry.claim?.subject, entry.claim?.relation, entry.claim?.object, entry.text]
    const match = fields.findIndex((value) => normalized(value ?? '').includes(term.value))
    if (match === -1) {
      return null
    }
    score += match < 3 ? 6 : 2
  }
  return score
}

export function searchConversationKnowledgeClaims(
  items: readonly ConversationKnowledgeItem[],
  query: string
): ConversationKnowledgeClaimMatch[] {
  const terms = searchTerms(query)
  if (!terms.length) {
    return []
  }
  return items
    .flatMap((item) =>
      (item.knowledge.handoff ?? []).flatMap((entry) => {
        const score = claimScore(entry, terms)
        return score === null ? [] : [{ item, entry, score }]
      })
    )
    .sort((left, right) => right.score - left.score)
}

export function hasStructuredClaimTerms(query: string): boolean {
  return searchTerms(query).some((term) => term.field !== null)
}
