import { expect, it } from 'vitest'
import {
  agentJournalItemSubagentId,
  isRootAgentJournalItem
} from './agent-session-journal-producer'
import type { NativeChatBlock } from '../../native-chat/native-chat-types'

it('groups only a background producer own task row under its owner on both journal and message readers', () => {
  const linkage = { agentId: 'shell', parentAgentId: 'owner', producerKind: 'background' as const }
  const task: NativeChatBlock = {
    type: 'background-task',
    taskId: 'shell',
    kind: 'command',
    label: 'sleep',
    state: 'working'
  }
  const output: NativeChatBlock = { type: 'text', text: 'workflow output' }
  for (const [blocks, expected] of [
    [[task], 'owner'],
    [[output], 'shell'],
    [[{ ...task, taskId: 'another' }], 'shell']
  ] as const) {
    expect(agentJournalItemSubagentId({ ...linkage, blocks })).toBe(expected)
    const journal = {
      ...linkage,
      body: { kind: 'message' as const, role: 'assistant' as const, blocks: [...blocks] }
    }
    expect(agentJournalItemSubagentId(journal)).toBe(expected)
    expect(isRootAgentJournalItem(journal)).toBe(false)
  }
  expect(isRootAgentJournalItem({})).toBe(true)
})
