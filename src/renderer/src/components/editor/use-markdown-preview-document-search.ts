import { useEffect, useState } from 'react'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { MarkdownPreviewDocumentMatch } from './markdown-preview-document-types'
import type { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'

type SearchResult = {
  client: MarkdownPreviewDocumentClient
  query: string
  matches: MarkdownPreviewDocumentMatch[]
  truncated: boolean
  failed: boolean
}

export function useMarkdownPreviewDocumentSearch(
  client: MarkdownPreviewDocumentClient | null,
  foundation: Pick<
    MarkdownPreviewFoundation,
    'query' | 'isSearchOpen' | 'setMatchCount' | 'setActiveMatchIndex'
  >,
  enabled: boolean
) {
  const { query, isSearchOpen, setMatchCount, setActiveMatchIndex } = foundation
  const [result, setResult] = useState<SearchResult | null>(null)
  useEffect(() => {
    if (!enabled || !client) {
      return
    }
    let current = true
    setMatchCount(0)
    setActiveMatchIndex(-1)
    void client
      .request({ type: 'search', query: isSearchOpen ? query : '' })
      .then((response) => {
        if (!current || response.type !== 'search') {
          return
        }
        setResult({
          client,
          query,
          matches: response.matches,
          truncated: response.truncated,
          failed: false
        })
        setMatchCount(response.matches.length)
        setActiveMatchIndex(response.matches.length > 0 ? 0 : -1)
      })
      .catch(() => {
        if (current) {
          setResult({ client, query, matches: [], truncated: false, failed: true })
        }
      })
    return () => {
      current = false
      client.cancel('search')
    }
  }, [client, enabled, isSearchOpen, query, setActiveMatchIndex, setMatchCount])
  const resolved = result?.client === client && result.query === query ? result : null
  return {
    matches: resolved?.matches ?? [],
    truncated: resolved?.truncated ?? false,
    failed: resolved?.failed ?? false,
    pending: enabled && isSearchOpen && query.length > 0 && !resolved
  }
}
