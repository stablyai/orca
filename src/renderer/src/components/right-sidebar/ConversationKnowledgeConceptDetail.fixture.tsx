import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ConversationKnowledgeGraph } from '../../../../shared/conversation-knowledge-graph'
import type { ConversationKnowledgeItem } from '../../../../shared/conversation-knowledge-items'
import { ConversationKnowledgeMap } from '../conversation-knowledge-map'
import { ConversationKnowledgeConceptDetail } from './ConversationKnowledgeConceptDetail'

const item: ConversationKnowledgeItem = {
  id: 'fixture-session',
  source: {
    executionHostId: 'local',
    agent: 'codex',
    sessionId: '00000000-0000-4000-8000-000000000001',
    title: '果汁盒抓取任务：只创建草案，不执行机器人动作',
    cwd: null,
    updatedAt: null
  },
  knowledge: { summary: '工具恢复自检与任务草案创建', topics: [], conclusions: [], entities: [] },
  generator: { agent: 'codex', model: 'gpt-5', generatedAt: '2026-11-23T00:00:00Z' }
}
const graph: ConversationKnowledgeGraph = { nodes: [], edges: [] }
for (let index = 0; index < 11; index += 1) {
  graph.nodes.push({
    id: `concept:${index}`,
    type: 'concept',
    label: index === 0 ? '任务草案创建' : `概念 ${index}`,
    itemCount: 1
  })
  if (index === 10) {
    continue
  }
  graph.nodes.push(
    {
      id: `digest:${index}`,
      type: 'digest',
      label: '工具恢复自检与果汁盒抓取任务草案创建',
      itemCount: 1,
      item
    },
    {
      id: `statement:${index}`,
      type: 'statement',
      label: `使用 noa_capabilities 与 noa_scene 核验现场后创建任务草案，只创建草案、不交接执行。${'草案目标必须保留用户原意，将右边的果汁盒抓取装到左侧的料框中，核实物体身份后再决定后续操作。'.repeat(3)}`,
      itemCount: 1,
      item,
      sourceBacked: {
        kind: 'constraint',
        reliability: 'verified',
        concepts: [index === 0 ? '任务草案创建' : `概念 ${index}`, `概念 ${index + 1}`]
      }
    }
  )
  graph.edges.push(
    { source: `digest:${index}`, target: `statement:${index}`, relation: 'records' },
    { source: `digest:${index}`, target: `concept:${index}`, relation: 'about' },
    { source: `digest:${index}`, target: `concept:${index + 1}`, relation: 'about' }
  )
}

function KnowledgeEvidencePreview(): React.JSX.Element {
  const [concept, setConcept] = useState(graph.nodes[0]!)
  return (
    <div className="flex h-[640px] bg-background text-foreground">
      <div className="min-w-0 flex-1">
        <ConversationKnowledgeMap
          graph={graph}
          selectedConceptId={concept.id}
          onSelectConcept={setConcept}
        />
      </div>
      <div className="scrollbar-sleek w-80 shrink-0 overflow-auto">
        <ConversationKnowledgeConceptDetail
          concept={concept}
          graph={graph}
          sourceHistoryScope="all"
          onSelectItem={() => {}}
        />
      </div>
    </div>
  )
}

export const longChineseEvidence = defineFixture({
  width: 1200,
  render: () => <KnowledgeEvidencePreview />
})
export const narrowChineseEvidence = defineFixture({
  width: 900,
  render: () => <KnowledgeEvidencePreview />
})
