import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  ConversationKnowledgeGraph,
  ConversationKnowledgeGraphNode
} from '../../../../shared/conversation-knowledge-graph'
import type { ConversationKnowledgeItem } from '../../../../shared/conversation-knowledge-items'

export function ConversationKnowledgeNoteDetail({
  note,
  graph,
  onSelectItem
}: {
  note: ConversationKnowledgeGraphNode
  graph: ConversationKnowledgeGraph
  onSelectItem: (item: ConversationKnowledgeItem) => void
}): React.JSX.Element {
  useTranslation()
  const evidence = useMemo(() => relatedEvidence(graph, note.id), [graph, note.id])
  const metadata = note.knowledgeNote
  return (
    <article className="space-y-4 p-4">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {translate('conversationKnowledge.note.eyebrow', 'Knowledge note')}
        </p>
        <h2 className="mt-1 text-base font-medium">{note.label}</h2>
        {metadata ? (
          <>
            <Badge className="mt-2" variant="outline">
              {metadata.status === 'verified'
                ? translate('conversationKnowledge.note.verified', 'Verified')
                : translate('conversationKnowledge.note.supported', 'Supported')}
            </Badge>
            <p className="mt-2 text-sm leading-6">{metadata.applicability}</p>
          </>
        ) : null}
      </div>
      <section>
        <h3 className="text-sm font-medium">
          {translate('conversationKnowledge.note.evidence', 'Supporting evidence')}
        </h3>
        <ul className="mt-2 space-y-1">
          {evidence.map((entry) => (
            <li key={entry.id}>
              <Button
                className="w-full justify-start text-left"
                variant="dense"
                onClick={() => entry.item && onSelectItem(entry.item)}
              >
                <span className="line-clamp-2">{entry.label}</span>
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </article>
  )
}

function relatedEvidence(
  graph: ConversationKnowledgeGraph,
  noteId: string
): ConversationKnowledgeGraphNode[] {
  const statementIds = new Set(
    graph.edges
      .filter((edge) => edge.target === noteId && edge.relation === 'supports')
      .map((edge) => edge.source)
  )
  return graph.nodes.filter((node) => statementIds.has(node.id) && node.type === 'statement')
}
