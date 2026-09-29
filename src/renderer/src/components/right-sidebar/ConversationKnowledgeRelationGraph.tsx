import { useState } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ConversationKnowledgeClaimMatch } from '@/lib/conversation-knowledge-claim-search'
import type { ConversationKnowledgeRelation } from '@/lib/conversation-knowledge-relations'
import { claimReliabilityLabel, claimStatusLabel } from './ConversationKnowledgeClaimResults'
import { conversationKnowledgeEvidenceMessageIds } from '../../../../shared/conversation-knowledge-items'

function conceptKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim()
}

export function ConversationKnowledgeRelationGraph({
  relations,
  onSelect
}: {
  relations: readonly ConversationKnowledgeRelation[]
  onSelect: (match: ConversationKnowledgeClaimMatch) => void
}): React.JSX.Element {
  const [focusedConcept, setFocusedConcept] = useState<string | null>(null)
  const visible = focusedConcept
    ? relations.filter(
        (relation) =>
          conceptKey(relation.subject) === focusedConcept ||
          conceptKey(relation.object) === focusedConcept
      )
    : relations

  if (!relations.length) {
    return (
      <div className="flex h-full min-h-52 items-center justify-center rounded-lg border border-border/60 bg-muted/15 px-6 text-center text-sm text-muted-foreground">
        {translate(
          'conversationKnowledge.relations.empty',
          'No source-backed statements or relationships yet. Regenerate knowledge to extract them.'
        )}
      </div>
    )
  }

  return (
    <div className="scrollbar-sleek h-full min-h-0 overflow-y-auto rounded-lg border border-border/60 bg-muted/15 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium">
          {translate(
            'conversationKnowledge.relations.title',
            'Source-backed statements and relationships'
          )}{' '}
          · {visible.length}
        </h2>
        {focusedConcept ? (
          <Button variant="ghost" size="xs" onClick={() => setFocusedConcept(null)}>
            <X className="size-3" />
            {translate('conversationKnowledge.relations.clearFocus', 'Show all')}
          </Button>
        ) : null}
      </div>
      <ul className="space-y-2">
        {visible.map((relation) => (
          <li key={relation.id} className="rounded-lg border border-border bg-background p-2.5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
              <Button
                variant="denseStrong"
                className="min-w-0 justify-start text-left"
                onClick={() => setFocusedConcept(conceptKey(relation.subject))}
              >
                <span className="truncate">{relation.subject}</span>
              </Button>
              <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                <ArrowRight className="size-3 shrink-0" />
                <span className="max-w-28 truncate">{relation.relation}</span>
                <ArrowRight className="size-3 shrink-0" />
              </div>
              <Button
                variant="denseStrong"
                className="min-w-0 justify-start text-left"
                onClick={() => setFocusedConcept(conceptKey(relation.object))}
              >
                <span className="truncate">{relation.object}</span>
              </Button>
            </div>
            <Badge className="mt-1" variant={relation.kind === 'claim' ? 'outline' : 'secondary'}>
              {relation.kind === 'claim'
                ? translate('conversationKnowledge.relations.structuredClaim', 'Structured claim')
                : translate(
                    'conversationKnowledge.relations.sourceBackedStatement',
                    'Source-backed statement'
                  )}
            </Badge>
            <div className="mt-1 border-t border-border pt-1">
              {relation.assertions.map((assertion) => (
                <Button
                  key={`${assertion.item.id}:${assertion.entry.evidence.messageId}:${assertion.entry.text}`}
                  variant="denseMuted"
                  className="w-full justify-start text-left"
                  onClick={() => onSelect(assertion)}
                >
                  <Badge
                    variant={
                      assertion.entry.lifecycle?.status === 'conflicted' ? 'secondary' : 'outline'
                    }
                  >
                    {claimStatusLabel(assertion.entry.lifecycle?.status)}
                  </Badge>
                  <span>{claimReliabilityLabel(assertion.entry.reliability)}</span>
                  <span className="min-w-0 truncate">
                    {assertion.item.source.agent} · {assertion.item.source.sessionId} ·{' '}
                    {conversationKnowledgeEvidenceMessageIds(assertion.entry).join(' · ')}
                  </span>
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
