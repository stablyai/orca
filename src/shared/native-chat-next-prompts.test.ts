import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentSessionLatestTurn } from './agent-session-wire'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { latestNativeChatNextPrompts, parseNativeChatNextPrompts } from './native-chat-next-prompts'

const reply = '完成。\n\n```orca-next-prompts\n["复核改动", "补充使用说明"]\n```'
const message: NativeChatMessage = {
  id: 'answer',
  role: 'assistant',
  state: 'completed',
  source: 'transcript',
  timestamp: 1,
  blocks: [{ type: 'text', text: reply }]
}

const row: AgentJournalRenderItem = {
  itemId: 'answer',
  revision: 1,
  sequence: 2,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: message.blocks },
  turnScope: { kind: 'turn', turnItemId: 'turn-record' }
}
const turn: AgentSessionLatestTurn = {
  itemId: 'turn-record',
  observedAt: 0,
  turn: { turnId: 'turn-provider', state: 'completed', outcome: 'success' }
}
const suggestions = (messages: readonly NativeChatMessage[]): string[] =>
  latestNativeChatNextPrompts(messages, [row], turn)

describe('native chat next prompts', () => {
  it.each([
    '```orca-next-prompts',
    '```orca-next-prompts\n["unfinished',
    '~~~orca-next-prompts\n["unfinished',
    '  ````orca-next-prompts\n["unfinished"]\n```'
  ])('hides an open protocol block only while streaming: %s', (block) => {
    const text = `Answer.\n\n${block}`
    expect(parseNativeChatNextPrompts(text, { hideOpenTrailingBlock: true })).toEqual({
      text: 'Answer.',
      prompts: []
    })
    expect(parseNativeChatNextPrompts(text)).toEqual({ text, prompts: [] })
    expect(parseNativeChatNextPrompts(text, { hideOpenTrailingBlock: false })).toEqual({
      text,
      prompts: []
    })
  })

  it.each([
    '```json\n["ordinary"]',
    '````markdown\n```orca-next-prompts\n["nested"]',
    '```orca-next-prompts\nnot json\n```',
    `${reply}\nMore explanation`
  ])('preserves ordinary, nested and closed invalid content while streaming: %s', (text) => {
    expect(parseNativeChatNextPrompts(text, { hideOpenTrailingBlock: true })).toEqual({
      text,
      prompts: []
    })
  })

  it('extracts and deduplicates only a complete trailing protocol block', () => {
    expect(parseNativeChatNextPrompts(reply)).toEqual({
      text: '完成。',
      prompts: ['复核改动', '补充使用说明']
    })
    expect(
      parseNativeChatNextPrompts('```orca-next-prompts\n["检查", "检查"]\n```').prompts
    ).toEqual(['检查'])
  })

  it.each([
    `${reply}\nMore explanation`,
    `\`\`\`\`markdown\n${reply}\n\`\`\`\``,
    '```orca-next-prompts\n["incomplete"]',
    '```orca-next-prompts\nnot json\n```',
    '```orca-next-prompts\n["a","b","c","d"]\n```',
    '```orca-next-prompts\n["a",123]\n```',
    '```orca-next-prompts\n["line\\nbreak"]\n```',
    `\`\`\`orca-next-prompts\n["${'a'.repeat(501)}"]\n\`\`\``,
    '```orca-next-prompts\n[]\n```'
  ])('preserves ordinary, nested, incomplete or invalid content: %s', (text) => {
    expect(parseNativeChatNextPrompts(text)).toEqual({ text, prompts: [] })
  })

  it('does not revive a suggestion after another message, or accept subagent and partial rows', () => {
    expect(suggestions([message])).toEqual(['复核改动', '补充使用说明'])
    for (const patch of [
      { role: 'user' as const },
      { role: 'tool' as const },
      { role: 'system' as const },
      { state: 'running' as const },
      { agentId: 'child' },
      { shortened: true as const },
      { queued: true as const }
    ]) {
      expect(suggestions([message, { ...message, ...patch }])).toEqual([])
    }
    expect(suggestions([])).toEqual([])
  })
})

it('uses a successful matching journal turn for real Codex rows without a message state', () => {
  const messages = projectStructuredItemsToNativeChat([row])
  expect(messages[0].state).toBeUndefined()
  expect(latestNativeChatNextPrompts(messages, [row], turn)).toEqual(['复核改动', '补充使用说明'])
  expect(latestNativeChatNextPrompts(messages, [row], undefined)).toEqual([])
  expect(
    latestNativeChatNextPrompts(messages, [row], {
      ...turn,
      turn: { ...turn.turn, state: 'running' }
    })
  ).toEqual([])
  expect(
    latestNativeChatNextPrompts(messages, [row], {
      ...turn,
      turn: { ...turn.turn, outcome: 'failure' }
    })
  ).toEqual([])
  expect(latestNativeChatNextPrompts(messages, [row], { ...turn, itemId: 'newer-turn' })).toEqual(
    []
  )
  expect(
    latestNativeChatNextPrompts(messages, [{ ...row, turnScope: { kind: 'thread' } }], turn)
  ).toEqual([])
})
