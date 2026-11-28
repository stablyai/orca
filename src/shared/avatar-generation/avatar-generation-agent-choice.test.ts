import { expect, it } from 'vitest'
import { pickAvatarAgent } from './avatar-generation-agent-choice'

it('runs with a signed-in agent over a remembered signed-out one, unless one was picked', () => {
  const agents = [
    { agent: 'codex', status: 'signed-out' },
    { agent: 'grok', status: 'ready' }
  ] as const

  expect(pickAvatarAgent(agents, { remembered: 'codex' })).toBe('grok')
  expect(pickAvatarAgent(agents, { chosen: 'codex', remembered: 'grok' })).toBe('codex')
})
