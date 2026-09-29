import { useEffect, useState } from 'react'
import type { ConversationKnowledgeItem } from '../../../shared/conversation-knowledge-items'

const EMPTY_KNOWLEDGE_ITEMS: ConversationKnowledgeItem[] = []

export function useWorktreeJumpPaletteKnowledgeSearch({
  enabled,
  query,
  visible
}: {
  enabled: boolean
  query: string
  visible: boolean
}) {
  const [items, setItems] = useState<ConversationKnowledgeItem[]>(EMPTY_KNOWLEDGE_ITEMS)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !visible) {
      setItems(EMPTY_KNOWLEDGE_ITEMS)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void window.api.aiVault
      .listKnowledge({ query: query.trim() })
      .then((result) => {
        if (!cancelled) {
          setItems(result.items.slice(0, 12))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems(EMPTY_KNOWLEDGE_ITEMS)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [enabled, query, visible])

  return { knowledgeItems: items, knowledgeLoading: loading }
}
