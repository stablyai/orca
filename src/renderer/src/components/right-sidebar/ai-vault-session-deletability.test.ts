import { describe, expect, it } from 'vitest'
import { aiVaultSessionDeleteBlockedReason } from './ai-vault-session-deletability'

// translate() with no loaded catalog returns the English fallback, so these
// assertions pin the English copy as well as the gate order.
const onHost = (host: string): string =>
  `This session is on ${host}. Orca can only delete sessions on this device, so copy its log path and delete the session's files on ${host}.`
const SYNTHETIC = "This session can't be deleted from Orca."
// Real SSH target ids are generated (`ssh-<ms>-<rand>`); the caller resolves the
// label the user gave the host, and only that label may reach the message.
const SSH_HOST_ID = 'ssh:ssh-1759012345678-k3j2h1'
const HOST_LABEL = 'Build box'

const localGeminiSession = {
  agent: 'gemini' as const,
  executionHostId: 'local' as const,
  filePath: '/home/user/.gemini/sessions/log.jsonl'
}

describe('aiVaultSessionDeleteBlockedReason', () => {
  it('offers Delete for a deletable agent on a local, real path', () => {
    expect(aiVaultSessionDeleteBlockedReason(localGeminiSession, 'Local')).toBeNull()
  })

  it('offers Delete for a directory-shaped agent (claude)', () => {
    expect(
      aiVaultSessionDeleteBlockedReason(
        {
          agent: 'claude',
          executionHostId: 'local',
          filePath: '/home/user/.claude/projects/-proj/sess-1.jsonl'
        },
        'Local'
      )
    ).toBeNull()
  })

  it('blocks ssh- and runtime-hosted sessions, naming the host by its label', () => {
    for (const executionHostId of [
      SSH_HOST_ID,
      'runtime:7c9e6679-7425-40de-944b-e07fc1f90ae7'
    ] as const) {
      const reason = aiVaultSessionDeleteBlockedReason(
        { ...localGeminiSession, executionHostId },
        HOST_LABEL
      )
      expect(reason).toBe(onHost(HOST_LABEL))
      expect(reason).not.toContain(executionHostId.slice(executionHostId.indexOf(':') + 1))
    }
  })

  it('blocks a synthetic OpenCode SQLite row identity', () => {
    expect(
      aiVaultSessionDeleteBlockedReason(
        {
          agent: 'opencode',
          executionHostId: 'local',
          filePath: '/home/user/.opencode/db.sqlite#sess_123'
        },
        'Local'
      )
    ).toBe(SYNTHETIC)
  })

  it('never tells the user to delete a remote synthetic row by hand', () => {
    // The copied "log path" of this row is the database holding every session.
    expect(
      aiVaultSessionDeleteBlockedReason(
        {
          agent: 'opencode',
          executionHostId: SSH_HOST_ID,
          filePath: '/home/user/.opencode/db.sqlite#sess_123'
        },
        HOST_LABEL
      )
    ).toBe("This session is on Build box, and it can't be deleted from Orca.")
  })

  it('names the agent without explaining why it is unsupported', () => {
    expect(
      aiVaultSessionDeleteBlockedReason(
        {
          agent: 'opencode',
          executionHostId: 'local',
          filePath: '/home/user/.opencode/sessions/log.jsonl'
        },
        'Local'
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
        'Local'
      )
    ).toBe("Antigravity sessions can't be deleted from Orca.")
  })

  it('names the host alongside the unsupported-agent reason, with no delete instruction', () => {
    expect(
      aiVaultSessionDeleteBlockedReason(
        {
          agent: 'opencode',
          executionHostId: SSH_HOST_ID,
          filePath: '/home/user/.opencode/sessions/log.jsonl'
        },
        HOST_LABEL
      )
    ).toBe("This session is on Build box, and OpenCode sessions can't be deleted from Orca.")
  })
})
