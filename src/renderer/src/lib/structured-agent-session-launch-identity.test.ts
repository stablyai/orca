import { describe, expect, it } from 'vitest'
import { structuredLaunchIdentity } from './structured-agent-session-launch-registry'

describe('structuredLaunchIdentity', () => {
  const fork = { sessionId: 'codex_parent', itemId: 'codex:thread:turn-1:1' }

  it('joins two forks of one turn, and keeps a fork apart from everything else', () => {
    const identity = structuredLaunchIdentity('wt-1', 'codex', { forkFrom: fork })

    // A double-click is one fork, not two chats.
    expect(structuredLaunchIdentity('wt-1', 'codex', { forkFrom: { ...fork } })).toBe(identity)
    expect(
      structuredLaunchIdentity('wt-1', 'codex', {
        forkFrom: { ...fork, itemId: 'codex:thread:turn-2:1' }
      })
    ).not.toBe(identity)
    // Never the blank launch a "+" would join, nor a resume.
    expect(structuredLaunchIdentity('wt-1', 'codex')).not.toBe(identity)
    expect(
      structuredLaunchIdentity('wt-1', 'codex', { resumeFrom: { providerSessionId: 'thread' } })
    ).not.toBe(identity)
  })
})
