import type {
  ConversationKnowledgeHandoffEntry,
  ConversationKnowledgeItem
} from '../../../shared/conversation-knowledge-items'
import {
  searchConversationKnowledgeClaims,
  type ConversationKnowledgeClaimMatch
} from './conversation-knowledge-claim-search'

export type ConversationKnowledgeRelation = {
  id: string
  kind: 'claim' | 'statement'
  subject: string
  relation: string
  object: string
  assertions: ConversationKnowledgeClaimMatch[]
}

function relationKey(claim: NonNullable<ConversationKnowledgeHandoffEntry['claim']>): string {
  return JSON.stringify(
    [claim.subject, claim.relation, claim.object].map((value) =>
      value.normalize('NFKC').toLocaleLowerCase().trim()
    )
  )
}

export function buildConversationKnowledgeRelations(
  items: readonly ConversationKnowledgeItem[],
  query: string
): ConversationKnowledgeRelation[] {
  const matches = query.trim()
    ? searchConversationKnowledgeClaims(items, query)
    : items.flatMap((item) =>
        (item.knowledge.handoff ?? []).map((entry) => ({ item, entry, score: 0 }))
      )
  const relations = new Map<string, ConversationKnowledgeRelation>()
  for (const match of matches) {
    const claim = match.entry.claim
    if (!claim) {
      const id = `statement:${match.item.id}:${match.entry.evidence.messageId}:${match.entry.text}`
      relations.set(id, {
        id,
        kind: 'statement',
        subject: match.item.knowledge.title ?? match.item.source.title,
        relation: 'records',
        object: match.entry.text,
        assertions: [match]
      })
      continue
    }
    const id = relationKey(claim)
    const existing = relations.get(id)
    if (existing) {
      existing.assertions.push(match)
    } else {
      relations.set(id, {
        id,
        kind: 'claim',
        subject: claim.subject,
        relation: claim.relation,
        object: claim.object,
        assertions: [match]
      })
    }
  }
  return [...relations.values()].sort(
    (left, right) =>
      right.assertions.length - left.assertions.length ||
      left.subject.localeCompare(right.subject) ||
      left.relation.localeCompare(right.relation) ||
      left.object.localeCompare(right.object)
  )
}
