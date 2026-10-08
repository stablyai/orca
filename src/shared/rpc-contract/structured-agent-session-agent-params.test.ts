import { describe, expect, it } from 'vitest'
import {
  AgentsParams,
  AttachParams,
  CreateIntentParams,
  CreateSupportParams,
  ModelCatalogParams
} from './structured-agent-session-params'

const ENVELOPE = {
  sessionId: 'agent-session-0123456789abcdef0123456789abcdef',
  clientOperationId: 'op-1',
  expectedRuntimeFence: null,
  payloadFingerprint: 'a'.repeat(64)
}

describe('structured agent params', () => {
  it.each(['claude', 'codex', 'grok', 'qwen-code'])('accept the agent id %s', (agent) => {
    expect(CreateSupportParams.safeParse({ worktree: 'wt', agent }).success).toBe(true)
    expect(ModelCatalogParams.safeParse({ agent }).success).toBe(true)
    expect(
      CreateIntentParams.safeParse({ envelope: ENVELOPE, worktree: 'wt', agent }).success
    ).toBe(true)
  })

  it.each(['', ' claude', 'grok agent', '../codex', 'a'.repeat(65), 7])(
    'refuse what is not an agent id: %s',
    (agent) => {
      expect(CreateSupportParams.safeParse({ worktree: 'wt', agent }).success).toBe(false)
      expect(ModelCatalogParams.safeParse({ agent }).success).toBe(false)
    }
  )

  it('keeps attaching by a client-supplied handle to Claude and Codex', () => {
    const attach = {
      envelope: ENVELOPE,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'wt',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/home/u/.codex' },
      runtimeKind: 'native',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    }
    expect(AttachParams.safeParse(attach).success).toBe(true)
    expect(AttachParams.safeParse({ ...attach, provider: 'grok' }).success).toBe(false)
  })

  it('takes nothing for the agent list', () => {
    expect(AgentsParams.safeParse({}).success).toBe(true)
    expect(AgentsParams.safeParse({ agent: 'grok' }).success).toBe(false)
  })
})
