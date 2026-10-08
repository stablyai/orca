import { describe, expect, it } from 'vitest'
import { CreateIntentParams } from './structured-agent-session-params'

const CREATE = {
  envelope: {
    sessionId: 'codex_11111111_2222_3333_4444_555555555555',
    clientOperationId: 'operation-1',
    expectedRuntimeFence: null,
    payloadFingerprint: 'a'.repeat(64)
  },
  worktree: 'id:repo-1::/repo/orca',
  agent: 'codex'
}
const FORK = { sessionId: 'codex_parent_chat_0001', itemId: 'codex:thread:turn-1:1' }

describe('agentSession.create forkFrom', () => {
  it('accepts a fork that names a chat and one of its rows', () => {
    expect(CreateIntentParams.safeParse({ ...CREATE, forkFrom: FORK }).success).toBe(true)
  })

  it('refuses a create that both resumes and forks', () => {
    const both = { ...CREATE, forkFrom: FORK, resumeFrom: { providerSessionId: 'thread-1' } }

    expect(CreateIntentParams.safeParse(both).success).toBe(false)
  })

  it('refuses anything beyond the identity, such as a cut point the client chose', () => {
    const chosen = { ...CREATE, forkFrom: { ...FORK, forkPoint: 'turn-9' } }

    expect(CreateIntentParams.safeParse(chosen).success).toBe(false)
  })
})
