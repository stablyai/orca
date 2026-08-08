import { describe, expect, it } from 'vitest'
import { aiVaultSessionDeleteBlockedReason } from './ai-vault-session-deletability'

// translate() with no loaded catalog returns the English fallback, so these
// assertions pin the English copy as well as the gate order.
const NON_LOCAL = 'Only sessions on this device can be deleted.'
const SYNTHETIC = "This session can't be deleted from Orca."
const LIVE = 'This session is still running — wait for it to finish before deleting.'

const localGeminiSession = {
  agent: 'gemini' as const,
  executionHostId: 'local' as const,
  filePath: '/home/user/.gemini/sessions/log.jsonl'
}

describe('aiVaultSessionDeleteBlockedReason', () => {
  it('offers Delete for a deletable agent on a local, real path', () => {
    expect(aiVaultSessionDeleteBlockedReason(localGeminiSession)).toBeNull()
  })

  it('offers Delete for a directory-shaped agent (claude)', () => {
    expect(
      aiVaultSessionDeleteBlockedReason({
        agent: 'claude',
        executionHostId: 'local',
        filePath: '/home/user/.claude/projects/-proj/sess-1.jsonl'
      })
    ).toBeNull()
  })

  it('tells the user to wait while the agent is still running', () => {
    for (const live of ['working', 'blocked', 'waiting'] as const) {
      expect(aiVaultSessionDeleteBlockedReason(localGeminiSession, live)).toBe(LIVE)
    }
  })

  it('offers Delete for a finished session (done) and one with no live state', () => {
    expect(aiVaultSessionDeleteBlockedReason(localGeminiSession, 'done')).toBeNull()
    expect(aiVaultSessionDeleteBlockedReason(localGeminiSession, null)).toBeNull()
  })

  it('keeps the permanent reason over "running" for an unsupported live session', () => {
    // A live but unsupported agent stays "unsupported" — it would never become
    // deletable, so "wait for it to finish" would mislead.
    expect(
      aiVaultSessionDeleteBlockedReason(
        { agent: 'codex', executionHostId: 'local', filePath: '/home/user/.codex/x.jsonl' },
        'working'
      )
    ).toBe("Codex sessions can't be deleted from Orca.")
  })

  it('blocks ssh- and runtime-hosted sessions regardless of agent', () => {
    for (const executionHostId of ['ssh:dev-box', 'runtime:gpu-box'] as const) {
      expect(aiVaultSessionDeleteBlockedReason({ ...localGeminiSession, executionHostId })).toBe(
        NON_LOCAL
      )
    }
  })

  it('blocks a synthetic OpenCode SQLite row identity', () => {
    expect(
      aiVaultSessionDeleteBlockedReason({
        agent: 'opencode',
        executionHostId: 'local',
        filePath: '/home/user/.opencode/db.sqlite#sess_123'
      })
    ).toBe(SYNTHETIC)
  })

  it('names the agent without explaining why it is unsupported', () => {
    expect(
      aiVaultSessionDeleteBlockedReason({
        agent: 'opencode',
        executionHostId: 'local',
        filePath: '/home/user/.opencode/sessions/log.jsonl'
      })
    ).toBe("OpenCode sessions can't be deleted from Orca.")
  })

  it('gives a multi-cause agent (antigravity) the same single sentence', () => {
    expect(
      aiVaultSessionDeleteBlockedReason({
        agent: 'antigravity',
        executionHostId: 'local',
        filePath: '/home/user/.antigravity/brain/conv-1/.system_generated/logs/transcript.jsonl'
      })
    ).toBe("Antigravity sessions can't be deleted from Orca.")
  })

  it('prioritizes the host gate over the unsupported-agent reason', () => {
    expect(
      aiVaultSessionDeleteBlockedReason({
        agent: 'claude',
        executionHostId: 'ssh:dev-box',
        filePath: '/home/user/.claude/sessions/sess-dir/log.jsonl'
      })
    ).toBe(NON_LOCAL)
  })
})
