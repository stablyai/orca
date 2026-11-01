import { describe, expect, it } from 'vitest'
import { aiVaultSessionDeleteBlockedReason } from './ai-vault-session-deletability'

// Without a loaded catalog, translate() returns English; pin copy and gate ordering together.
const NON_LOCAL = 'Only sessions on this device can be deleted.'
const SYNTHETIC = "This session can't be deleted from Orca."
const HOST = { label: 'Build box', deleteSupported: null }

const localGeminiSession = {
  agent: 'gemini' as const,
  executionHostId: 'local' as const,
  filePath: '/home/user/.gemini/sessions/log.jsonl'
}

describe('aiVaultSessionDeleteBlockedReason', () => {
  it('offers Delete for a deletable agent on a local, real path', () => {
    expect(aiVaultSessionDeleteBlockedReason(localGeminiSession, HOST)).toBeNull()
  })

  it('offers Delete for a directory-shaped agent (claude)', () => {
    expect(
      aiVaultSessionDeleteBlockedReason(
        {
          agent: 'claude',
          executionHostId: 'local',
          filePath: '/home/user/.claude/projects/-proj/sess-1.jsonl'
        },
        HOST
      )
    ).toBeNull()
  })

  it('offers Delete for a session on a paired or SSH-managed server, routed to that server', () => {
    for (const deleteSupported of [true, null]) {
      expect(
        aiVaultSessionDeleteBlockedReason(
          { ...localGeminiSession, executionHostId: 'runtime:gpu-box' },
          { label: 'GPU box', deleteSupported }
        )
      ).toBeNull()
    }
  })

  it('asks to update a server that predates remote delete, naming it', () => {
    expect(
      aiVaultSessionDeleteBlockedReason(
        { ...localGeminiSession, executionHostId: 'runtime:gpu-box' },
        { label: 'GPU box', deleteSupported: false }
      )
    ).toBe('Update GPU box to delete its sessions from here.')
  })

  it('blocks an unroutable owner such as a legacy SSH relay or a contested workspace', () => {
    for (const executionHostId of ['ssh:dev-box', 'runtime:unresolved-owner'] as const) {
      expect(
        aiVaultSessionDeleteBlockedReason({ ...localGeminiSession, executionHostId }, HOST)
      ).toBe(NON_LOCAL)
    }
  })

  it('blocks a synthetic OpenCode SQLite row identity on any host', () => {
    for (const executionHostId of ['local', 'runtime:gpu-box'] as const) {
      expect(
        aiVaultSessionDeleteBlockedReason(
          {
            agent: 'opencode',
            executionHostId,
            filePath: '/home/user/.opencode/db.sqlite#sess_123'
          },
          { label: 'GPU box', deleteSupported: false }
        )
      ).toBe(SYNTHETIC)
    }
  })

  it('names the agent without explaining why it is unsupported', () => {
    expect(
      aiVaultSessionDeleteBlockedReason(
        {
          agent: 'opencode',
          executionHostId: 'local',
          filePath: '/home/user/.opencode/sessions/log.jsonl'
        },
        HOST
      )
    ).toBe("OpenCode sessions can't be deleted from Orca.")
  })

  it('gives a multi-cause agent (antigravity) the same single sentence', () => {
    expect(
      aiVaultSessionDeleteBlockedReason(
        {
          agent: 'antigravity',
          executionHostId: 'local',
          filePath: '/home/user/.antigravity/brain/conv-1/.system_generated/logs/transcript.jsonl'
        },
        HOST
      )
    ).toBe("Antigravity sessions can't be deleted from Orca.")
  })

  it('prioritizes the host gate over the unsupported-agent reason', () => {
    expect(
      aiVaultSessionDeleteBlockedReason(
        {
          agent: 'claude',
          executionHostId: 'ssh:dev-box',
          filePath: '/home/user/.claude/sessions/sess-dir/log.jsonl'
        },
        HOST
      )
    ).toBe(NON_LOCAL)
  })
})
