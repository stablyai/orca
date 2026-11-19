import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { withClaudeTranscriptModelLabel } from './claude-terminal-session-options'

it('shows the last response model on reopen and keeps a newer picker selection', () => {
  const picker: SessionOptionDescriptor = {
    id: 'model',
    label: 'Model',
    transport: 'catalog',
    valueSource: 'unknown',
    settable: true,
    kind: { type: 'select', choices: [] }
  }
  const reply: NativeChatMessage = {
    id: 'older',
    source: 'transcript',
    role: 'assistant',
    blocks: [],
    timestamp: 1,
    model: 'claude-sonnet-5-5'
  }
  const history: NativeChatMessage[] = [
    reply,
    { ...reply, id: 'newer', role: 'reasoning', model: 'claude-opus-5-5', effort: 'high' },
    { id: 'next', source: 'transcript', role: 'user', blocks: [], timestamp: 3 }
  ]
  expect(withClaudeTranscriptModelLabel([picker], history)[0]?.kind).toEqual({
    type: 'select',
    choices: [],
    placeholder: 'Claude Opus 5.5',
    lastResponseEffort: 'high'
  })
  const pickedEffort: SessionOptionDescriptor = {
    ...picker,
    id: 'effort',
    valueSource: 'dispatched',
    kind: { type: 'select', choices: [], currentValue: 'low' }
  }
  expect(
    withClaudeTranscriptModelLabel([picker, pickedEffort], history)[0]?.kind
  ).not.toHaveProperty('lastResponseEffort')
  expect(
    withClaudeTranscriptModelLabel(
      [picker],
      [...history, { ...reply, id: 'latest', model: 'claude-opus-5-5' }]
    )[0]?.kind
  ).not.toHaveProperty('lastResponseEffort')
  const picked: SessionOptionDescriptor = {
    ...picker,
    valueSource: 'applied',
    kind: { type: 'select', choices: [], currentValue: 'sonnet' }
  }
  expect(withClaudeTranscriptModelLabel([picked], history)).toEqual([picked])
  expect(withClaudeTranscriptModelLabel([picker], [])).toEqual([picker])
})
