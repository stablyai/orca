import type {
  ConversationKnowledgeHandoffEntry,
  ConversationKnowledgeItem
} from './conversation-knowledge-items'

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function claimKey(
  item: ConversationKnowledgeItem,
  entry: ConversationKnowledgeHandoffEntry
): string | null {
  if (
    !item.source.cwd ||
    entry.reliability !== 'user-confirmed' ||
    !entry.claim ||
    (entry.lifecycle?.status &&
      entry.lifecycle.status !== 'active' &&
      entry.lifecycle.reason !== 'automatic-conflict')
  ) {
    return null
  }
  const { subject, relation, object, cardinality } = entry.claim
  if (cardinality !== 'single' || !subject.trim() || !relation.trim() || !object.trim()) {
    return null
  }
  return [
    item.source.executionHostId,
    item.source.cwd,
    normalized(subject),
    normalized(relation)
  ].join('\u0000')
}

export function reconcileConversationKnowledgeConflicts(
  items: readonly ConversationKnowledgeItem[]
): ConversationKnowledgeItem[] {
  const valuesByKey = new Map<string, Set<string>>()
  for (const item of items) {
    for (const entry of item.knowledge.handoff ?? []) {
      const key = claimKey(item, entry)
      if (!key || !entry.claim) {
        continue
      }
      const values = valuesByKey.get(key) ?? new Set<string>()
      values.add(normalized(entry.claim.object))
      valuesByKey.set(key, values)
    }
  }
  return items.map((item) => ({
    ...item,
    knowledge: {
      ...item.knowledge,
      ...(item.knowledge.handoff
        ? {
            handoff: item.knowledge.handoff.map((entry) => {
              const key = claimKey(item, entry)
              const conflicted = key && (valuesByKey.get(key)?.size ?? 0) > 1
              if (conflicted) {
                return {
                  ...entry,
                  lifecycle: {
                    status: 'conflicted' as const,
                    reason: 'automatic-conflict' as const
                  }
                }
              }
              if (entry.lifecycle?.reason === 'automatic-conflict') {
                return { ...entry, lifecycle: { status: 'active' as const } }
              }
              return entry
            })
          }
        : {})
    }
  }))
}
