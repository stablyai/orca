import { Bot, Info, User, Wrench } from 'lucide-react'
import type { AiVaultSearchEvidence } from '../../../../shared/ai-vault-search-types'
import { conversationRoleLabel } from './ai-vault-session-row-display'

const ROLE_GLYPH = {
  user: User,
  assistant: Bot,
  tool: Wrench,
  system: Info,
  unknown: Info
} as const

export type AiVaultSearchSnippetSegment = { text: string; matched: boolean }

/** Splits an FTS5 snippet on its `[term]` match markers. */
export function aiVaultSearchSnippetSegments(snippet: string): AiVaultSearchSnippetSegment[] {
  const segments: AiVaultSearchSnippetSegment[] = []
  let cursor = 0
  const pattern = /\[([^[\]]*)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(snippet)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: snippet.slice(cursor, match.index), matched: false })
    }
    if (match[1]) {
      segments.push({ text: match[1], matched: true })
    }
    cursor = match.index + match[0].length
  }
  if (cursor < snippet.length) {
    segments.push({ text: snippet.slice(cursor), matched: false })
  }
  return segments
}

export function AiVaultSearchEvidenceLine({
  evidence
}: {
  evidence: AiVaultSearchEvidence
}): React.JSX.Element | null {
  if (!evidence.snippet) {
    return null
  }
  const RoleGlyph = ROLE_GLYPH[evidence.role]
  const roleLabel = conversationRoleLabel(evidence.role)
  return (
    <div className="mt-1 flex min-w-0 items-start gap-1 text-[11px] leading-4 text-muted-foreground">
      <RoleGlyph aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="sr-only">{roleLabel}</span>
      <span className="min-w-0 line-clamp-2 [overflow-wrap:anywhere]">
        {aiVaultSearchSnippetSegments(evidence.snippet).map((segment, index) =>
          segment.matched ? (
            // Same match treatment the code-search results in this sidebar use.
            <span
              className="rounded-sm bg-amber-500/30 text-foreground"
              key={`${index}:${segment.text}`}
            >
              {segment.text}
            </span>
          ) : (
            <span key={`${index}:${segment.text}`}>{segment.text}</span>
          )
        )}
      </span>
    </div>
  )
}
