import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { createNativeChatPtySessionOptions } from '../../../../../../../shared/native-chat/input/session-options/native-chat-pty-session-options'
import {
  readClaudeSessionOptionsFromTerminalScreen,
  withClaudeTranscriptModelLabel
} from './claude-terminal-session-options'

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

it('uses the version from the banner when the picker only has a family alias', () => {
  const report = (name: string) =>
    readClaudeSessionOptionsFromTerminalScreen(`Claude Code v1.0.0\n${name} · API Usage Billing`)!
  const surface = createNativeChatPtySessionOptions({
    agent: 'claude',
    scopeKey: 'alias-banner',
    mode: 'live',
    modelLabel: 'Model',
    reportedValues: report('Opus 5.5'),
    dispatchCommand: async () => {}
  })!
  const reply: NativeChatMessage = {
    id: 'reply',
    source: 'transcript',
    role: 'assistant',
    blocks: [],
    timestamp: 1,
    model: 'claude-opus-5-5',
    effort: 'medium'
  }
  const model = () => withClaudeTranscriptModelLabel(surface.getSnapshot(), [reply])[0]?.kind
  expect(model()).toMatchObject({ currentValue: 'opus', lastResponseEffort: 'medium' })
  surface.reportSessionOptions(report('Opus 5'))
  expect(model()).not.toHaveProperty('lastResponseEffort')
  surface.reportSessionOptions(report('Sonnet 5.5'))
  expect(model()).not.toHaveProperty('lastResponseEffort')
})
