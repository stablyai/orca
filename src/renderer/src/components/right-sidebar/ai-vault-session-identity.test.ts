import { describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { EMPTY_AI_VAULT_SESSIONS, reuseAiVaultListResult } from './ai-vault-session-identity'

// Why: production rows carry nested previewMessages + subagent. A scalar
// {id, title} fixture reconciles even when the walker is broken, which is how
// a scannedAt-only or Object.is fix stays green.
function makeProductionSession(index: number, title = `session-${index}`): AiVaultSession {
  const id = `local:codex:session-${index}:/sessions/session-${index}.jsonl`
  const timestamp = new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString()
  return {
    id,
    executionHostId: 'local',
    executionHostPlatform: 'darwin',
    agent: 'codex',
    sessionId: `session-${index}`,
    title,
    cwd: '/Users/ada/orca',
    branch: 'nwparker/ai-vault-session-list-identity',
    model: 'gpt-5',
    filePath: `/sessions/session-${index}.jsonl`,
    codexHome: '/Users/ada/.codex',
    createdAt: timestamp,
    updatedAt: timestamp,
    modifiedAt: timestamp,
    messageCount: 4,
    totalTokens: 1800,
    previewMessages: [
      {
        role: 'user',
        text: 'keep session list identity on reminted scannedAt',
        timestamp
      },
      {
        role: 'assistant',
        text: 'reuse previous row refs when the transcript did not change',
        timestamp
      }
    ],
    previewMessagesTruncated: true,
    lastUserPrompt: 'keep session list identity on reminted scannedAt',
    queuedMessageCount: 0,
    subagentTranscriptCount: 1,
    resumeCommand: `codex resume session-${index}`,
    subagent: {
      parentSessionId: `session-${index}`,
      agentType: 'Explore',
      status: 'completed'
    }
  }
}

function cloneResult(result: AiVaultListResult, scannedAt: string): AiVaultListResult {
  const cloned = structuredClone(result)
  cloned.scannedAt = scannedAt
  return cloned
}

describe('reuseAiVaultListResult', () => {
  it('keeps the result, rows, and nested previewMessages across independently cloned remints', () => {
    const current: AiVaultListResult = {
      sessions: [makeProductionSession(1), makeProductionSession(2)],
      issues: [
        {
          executionHostId: 'ssh:dev-box',
          agent: 'codex',
          kind: 'scope',
          path: '/home/ada',
          message: 'Only the first 64 project paths were scanned.'
        }
      ],
      scannedAt: '2026-07-01T00:00:00.000Z'
    }
    const incoming = cloneResult(current, '2026-07-01T00:00:15.000Z')
    expect(incoming).not.toBe(current)
    expect(incoming.sessions).not.toBe(current.sessions)
    expect(incoming.sessions[0]).not.toBe(current.sessions[0])
    expect(incoming.sessions[0]?.previewMessages).not.toBe(current.sessions[0]?.previewMessages)
    expect(incoming.sessions[0]?.subagent).not.toBe(current.sessions[0]?.subagent)
    expect(incoming.issues).not.toBe(current.issues)

    const reused = reuseAiVaultListResult(current, incoming)
    expect(reused).toBe(current)
    expect(reused.sessions).toBe(current.sessions)
    expect(reused.sessions[0]).toBe(current.sessions[0])
    expect(reused.sessions[0]?.previewMessages).toBe(current.sessions[0]?.previewMessages)
    expect(reused.issues).toBe(current.issues)
  })

  it('replaces a changed row but reuses the unchanged sibling', () => {
    const current: AiVaultListResult = {
      sessions: [makeProductionSession(1), makeProductionSession(2)],
      issues: [],
      scannedAt: '2026-07-01T00:00:00.000Z'
    }
    const incoming = cloneResult(current, '2026-07-01T00:00:15.000Z')
    const changed = incoming.sessions[1]
    if (!changed?.previewMessages[0]) {
      throw new Error('expected a nested preview message')
    }
    changed.previewMessages[0] = { ...changed.previewMessages[0], text: 'a new user turn' }

    const reused = reuseAiVaultListResult(current, incoming)
    expect(reused).not.toBe(current)
    expect(reused).not.toBe(incoming)
    expect(reused.sessions[0]).toBe(current.sessions[0])
    expect(reused.sessions[1]).not.toBe(current.sessions[1])
    expect(reused.sessions[1]?.previewMessages[0]?.text).toBe('a new user turn')
    expect(reused.scannedAt).toBe('2026-07-01T00:00:15.000Z')
  })

  it('replaces issues when sessions are unchanged', () => {
    const hostIssue = {
      executionHostId: 'ssh:dev-box' as const,
      agent: 'codex' as const,
      kind: 'host' as const,
      path: 'dev-box',
      message: 'Remote connection dropped.'
    }
    const current: AiVaultListResult = {
      sessions: [makeProductionSession(1)],
      issues: [hostIssue],
      scannedAt: '2026-07-01T00:00:00.000Z'
    }
    const incoming = cloneResult(current, '2026-07-01T00:00:15.000Z')
    incoming.issues = []

    const reused = reuseAiVaultListResult(current, incoming)
    expect(reused).not.toBe(current)
    expect(reused.sessions).toBe(current.sessions)
    expect(reused.issues).toEqual([])
    expect(reused.issues).toBe(incoming.issues)
  })
})

describe('EMPTY_AI_VAULT_SESSIONS', () => {
  // Every mounted hook returns this same array before its first scan lands.
  it('is frozen so one panel cannot mutate the sentinel for the others', () => {
    expect(EMPTY_AI_VAULT_SESSIONS).toHaveLength(0)
    expect(Object.isFrozen(EMPTY_AI_VAULT_SESSIONS)).toBe(true)
  })
})
