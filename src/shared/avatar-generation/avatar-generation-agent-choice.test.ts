import { describe, expect, it } from 'vitest'
import { pickAvatarAgent } from './avatar-generation-agent-choice'

describe('pickAvatarAgent', () => {
  it('opens on the remembered agent while it is offered, even signed out', () => {
    expect(
      pickAvatarAgent(
        [
          { agent: 'codex', status: 'ready' },
          { agent: 'grok', status: 'signed-out' }
        ],
        'grok'
      )
    ).toBe('grok')
  })

  it('falls back to the first ready agent when the remembered one is gone', () => {
    expect(
      pickAvatarAgent(
        [
          { agent: 'codex', status: 'signed-out' },
          { agent: 'grok', status: 'ready' }
        ],
        undefined
      )
    ).toBe('grok')
    expect(pickAvatarAgent([{ agent: 'codex', status: 'signed-out' }], 'grok')).toBe('codex')
  })

  it('has no agent when none can make images', () => {
    expect(pickAvatarAgent([], 'codex')).toBeNull()
  })
})
