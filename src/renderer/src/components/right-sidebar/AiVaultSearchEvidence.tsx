import type React from 'react'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import { translate } from '@/i18n/i18n'
import { conversationRoleLabel } from './ai-vault-session-row-display'

export function highlightedSearchSnippet(snippet: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const marker = /\[\[([\s\S]*?)\]\]/g
  let offset = 0

  for (const match of snippet.matchAll(marker)) {
    const index = match.index
    if (index > offset) {
      parts.push(snippet.slice(offset, index))
    }
    parts.push(
      <mark
        key={`${index}:${match[1]}`}
        className="rounded-sm bg-sidebar-accent px-0.5 font-medium text-sidebar-accent-foreground"
      >
        {match[1]}
      </mark>
    )
    offset = index + match[0].length
  }

  if (offset < snippet.length) {
    parts.push(snippet.slice(offset))
  }
  return parts
}

export function AiVaultSearchEvidence({ hit }: { hit: AiVaultSearchHit }): React.JSX.Element {
  const evidence = hit.evidence
  let availability: string | null = null
  if (hit.source.presence === 'unverifiable') {
    availability = translate(
      'auto.components.right.sidebar.AiVaultSearchEvidence.sourceUnverifiable',
      'Transcript availability could not be verified'
    )
  } else if (hit.source.presence === 'missing') {
    availability = translate(
      'auto.components.right.sidebar.AiVaultSearchEvidence.sourceMissing',
      'Transcript is no longer available'
    )
  }

  return (
    <div className="mt-0.5 min-w-0 text-[12px] leading-4 text-muted-foreground">
      {evidence ? (
        <div className="line-clamp-2">
          <span className="font-medium text-foreground/80">
            {conversationRoleLabel(evidence.role)}
          </span>
          <span>: {highlightedSearchSnippet(evidence.snippet)}</span>
        </div>
      ) : (
        <div className="line-clamp-1">
          {translate(
            'auto.components.right.sidebar.AiVaultSearchEvidence.metadataMatch',
            'Match in session metadata'
          )}
        </div>
      )}
      {availability ? <div className="line-clamp-1 text-[11px]">{availability}</div> : null}
    </div>
  )
}
