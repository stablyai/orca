import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openConversationKnowledgeSourceHistory } from '@/lib/conversation-knowledge-source-history'
import type {
  ConversationKnowledgeGraph,
  ConversationKnowledgeGraphNode
} from '../../../../shared/conversation-knowledge-graph'
import type { ConversationKnowledgeItem } from '../../../../shared/conversation-knowledge-items'

export function ConversationKnowledgeConceptDetail({
  concept,
  graph,
  sourceHistoryScope,
  onSelectItem
}: {
  concept: ConversationKnowledgeGraphNode
  graph: ConversationKnowledgeGraph
  sourceHistoryScope: 'all' | 'project'
  onSelectItem: (item: ConversationKnowledgeItem) => void
}): React.JSX.Element {
  useTranslation()
  const { digests, sessions, statements } = useMemo(
    () => relatedConceptKnowledge(graph, concept.id),
    [concept.id, graph]
  )

  return (
    <article className="space-y-4 p-4">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {translate('conversationKnowledge.conceptOverview.eyebrow', 'Concept overview')}
        </p>
        <h2 className="mt-1 text-base font-medium">{concept.label}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {translate(
            'conversationKnowledge.conceptOverview.description',
            'Observed in {{count}} conversation digests. This is not a verified knowledge note.',
            { count: digests.length }
          )}
        </p>
      </div>
      <ConceptSection
        title={translate(
          'conversationKnowledge.conceptOverview.sourceBacked',
          'Source-backed statements'
        )}
        empty={translate(
          'conversationKnowledge.conceptOverview.noSourceBacked',
          'No source-backed statements are linked to this concept yet.'
        )}
        entries={statements}
        onSelectItem={onSelectItem}
      />
      <SourceSessionSection sessions={sessions} sourceHistoryScope={sourceHistoryScope} />
      <ConceptSection
        title={translate('conversationKnowledge.conceptOverview.digests', 'Conversation digests')}
        empty={translate(
          'conversationKnowledge.conceptOverview.noDigests',
          'No conversation digests are linked to this concept.'
        )}
        entries={digests}
        onSelectItem={onSelectItem}
      />
    </article>
  )
}

function ConceptSection({
  title,
  empty,
  entries,
  onSelectItem
}: {
  title: string
  empty: string
  entries: readonly ConversationKnowledgeGraphNode[]
  onSelectItem: (item: ConversationKnowledgeItem) => void
}): React.JSX.Element {
  return (
    <section>
      <h3 className="text-sm font-medium">{title}</h3>
      {entries.length ? (
        <ul className="mt-2 space-y-1">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Button
                className="w-full justify-start whitespace-normal text-left"
                variant="dense"
                onClick={() => entry.item && onSelectItem(entry.item)}
              >
                <span className="block break-words">{entry.label}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">{empty}</p>
      )}
    </section>
  )
}

function SourceSessionSection({
  sessions,
  sourceHistoryScope
}: {
  sessions: readonly ConversationKnowledgeItem[]
  sourceHistoryScope: 'all' | 'project'
}): React.JSX.Element {
  return (
    <section>
      <h3 className="text-sm font-medium">
        {translate('conversationKnowledge.conceptOverview.sourceSessions', 'Source sessions')}
      </h3>
      {sessions.length ? (
        <ul className="mt-2 space-y-1">
          {sessions.map((item) => (
            <li key={item.id}>
              <Button
                className="w-full justify-start whitespace-normal text-left"
                variant="dense"
                onClick={() => openConversationKnowledgeSourceHistory(item, sourceHistoryScope)}
              >
                <span className="min-w-0 break-words">
                  <span className="block font-mono text-[11px]">{item.source.sessionId}</span>
                  <span className="mt-0.5 block text-muted-foreground">{item.source.title}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {translate(
            'conversationKnowledge.conceptOverview.noSourceSessions',
            'No source sessions are linked to this concept.'
          )}
        </p>
      )}
    </section>
  )
}

function relatedConceptKnowledge(
  graph: ConversationKnowledgeGraph,
  conceptId: string
): {
  digests: ConversationKnowledgeGraphNode[]
  sessions: ConversationKnowledgeItem[]
  statements: ConversationKnowledgeGraphNode[]
} {
  const digestIds = new Set(
    graph.edges
      .filter((edge) => edge.target === conceptId && edge.relation !== 'contains')
      .map((edge) => edge.source)
  )
  const statementIds = new Set(
    graph.edges
      .filter((edge) => digestIds.has(edge.source) && edge.relation === 'records')
      .map((edge) => edge.target)
  )
  const digests = graph.nodes.filter((node) => digestIds.has(node.id) && node.type === 'digest')
  return {
    digests,
    sessions: [
      ...new Map(
        digests.flatMap((digest) => (digest.item ? [[digest.item.id, digest.item]] : []))
      ).values()
    ].sort((left, right) =>
      (right.source.updatedAt ?? '').localeCompare(left.source.updatedAt ?? '')
    ),
    statements: graph.nodes.filter((node) => statementIds.has(node.id) && node.type === 'statement')
  }
}
