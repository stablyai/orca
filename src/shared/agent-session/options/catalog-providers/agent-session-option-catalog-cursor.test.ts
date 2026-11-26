import { expect, it } from 'vitest'
import { resolveAgentSessionOptionLaunch } from '../launch/agent-session-option-launch'

it('adds -thinking only to Claude models whose cursor-agent ids have it', () => {
  const args = (values: Record<string, string | boolean>) =>
    resolveAgentSessionOptionLaunch('cursor', values).args
  expect(args({ model: 'claude-opus-5-5', effort: 'high' })).toEqual([
    '--model',
    'claude-opus-5-5-high'
  ])
  expect(args({ model: 'claude-fable-5-2', effort: 'xhigh', fastMode: true })).toEqual([
    '--model',
    'claude-fable-5-2-xhigh-fast'
  ])
  expect(args({ model: 'claude-opus-5', effort: 'max', fastMode: true })).toEqual([
    '--model',
    'claude-opus-5-thinking-max-fast'
  ])
})
