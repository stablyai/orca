import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ConversationKnowledgeItem } from '../../../src/shared/conversation-knowledge-items'

export const KNOWLEDGE_SOURCE_ID = '00000000-0000-4000-8000-000000000001'
export const KNOWLEDGE_SOURCE_TITLE = '果汁盒抓取任务：只创建草案，不执行机器人动作'
export const KNOWLEDGE_CONCEPT = '任务草案创建'
const CONCEPTS = [KNOWLEDGE_CONCEPT, ...Array.from({ length: 10 }, (_, i) => `概念${i + 1}`)]

export function seedGoldenConversationKnowledge(
  userDataPath: string,
  home: string,
  cwd: string
): void {
  const directory = path.join(userDataPath, 'profiles', 'local-default')
  const sessions = path.join(home, '.codex', 'sessions', '2026', '11', '23')
  mkdirSync(directory, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  const items: ConversationKnowledgeItem[] = CONCEPTS.slice(0, -1).map((concept, index) => {
    const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    const title = index === 0 ? KNOWLEDGE_SOURCE_TITLE : `来源会话 ${index + 1}`
    const text = `使用 noa_capabilities 与 noa_scene 核验现场后创建任务草案，必须保留用户原意，只创建草案，不下发机器人动作。${'需核实现场状态与左右两侧物体身份后再决定后续操作。'.repeat(4)}`
    writeFileSync(
      path.join(sessions, `rollout-2026-11-23T00-00-00-${sessionId}.jsonl`),
      [
        {
          type: 'session_meta',
          timestamp: '2026-11-23T00:00:00.000Z',
          payload: { id: sessionId, cwd }
        },
        {
          type: 'response_item',
          timestamp: '2026-11-23T00:00:01.000Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] }
        },
        {
          type: 'response_item',
          timestamp: '2026-11-23T00:00:02.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
        }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
        .concat('\n')
    )
    return {
      id: `local:codex:${sessionId}`,
      source: {
        executionHostId: 'local',
        agent: 'codex',
        sessionId,
        title,
        cwd,
        updatedAt: '2026-11-23T00:00:02.000Z'
      },
      generator: {
        agent: 'codex',
        model: 'gpt-5',
        language: 'zh',
        generatedAt: '2026-11-23T00:00:03.000Z'
      },
      knowledge: {
        summary: title,
        topics: [concept, CONCEPTS[index + 1]!],
        conclusions: [],
        entities: [],
        handoff: [1, 2].map((number) => ({
          kind: 'constraint',
          text: `${text} 核验项${number}`,
          reliability: 'user-confirmed',
          concepts: [concept, CONCEPTS[index + 1]!],
          evidence: { kind: 'conversation', messageId: 'user-1' }
        }))
      }
    }
  })
  writeFileSync(
    path.join(directory, 'conversation-knowledge.json'),
    JSON.stringify({ version: 1, items })
  )
}
