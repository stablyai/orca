import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { prepareAiVaultSessionForResume } from './ai-vault-session-resume-preparation'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('prepareAiVaultSessionForResume', () => {
  it('returns a real-home launch identity only after targeted materialization succeeds', async () => {
    const prepareSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: true })
    stubPreparation(prepareSessionResume)
    const legacy = session({
      codexHome: '/Users/ada/Library/Application Support/orca/codex-runtime-home/home'
    })

    const prepared = await prepareAiVaultSessionForResume(legacy)

    expect(prepared.codexHome).toBeNull()
    expect(prepareSessionResume).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: legacy.sessionId,
      filePath: legacy.filePath,
      codexHome: legacy.codexHome,
      executionHostId: 'local'
    })
  })

  it('rejects without changing the launch identity when materialization fails', async () => {
    stubPreparation(vi.fn().mockRejectedValue(new Error('Retry resume.')))

    await expect(
      prepareAiVaultSessionForResume(session({ codexHome: '/tmp/orca/codex-runtime-home/home' }))
    ).rejects.toThrow('Retry resume.')
  })

  it('preserves a custom home without materialization', async () => {
    const prepareSessionResume = vi.fn()
    stubPreparation(prepareSessionResume)
    const current = session({ codexHome: '/custom/codex' })

    await expect(prepareAiVaultSessionForResume(current)).resolves.toBe(current)
    expect(prepareSessionResume).not.toHaveBeenCalled()
  })

  it('repins a per-account session to the home the host substitutes', async () => {
    const prepareSessionResume = vi.fn().mockResolvedValue({
      useRealCodexHome: false,
      substituteCodexHome: '/tmp/orca/codex-accounts/account-2/home'
    })
    stubPreparation(prepareSessionResume)
    const current = session({ codexHome: '/tmp/orca/codex-accounts/account-1/home' })

    const prepared = await prepareAiVaultSessionForResume(current)

    expect(prepared.codexHome).toBe('/tmp/orca/codex-accounts/account-2/home')
    expect(prepareSessionResume).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: current.sessionId,
      filePath: current.filePath,
      codexHome: current.codexHome,
      executionHostId: 'local'
    })
  })

  it('keeps a per-account session unchanged when the host declines to repin', async () => {
    stubPreparation(vi.fn().mockResolvedValue({ useRealCodexHome: false }))
    const current = session({ codexHome: '/tmp/orca/codex-accounts/account-1/home' })

    await expect(prepareAiVaultSessionForResume(current)).resolves.toBe(current)
  })

  it('does not ask a remote host to repin a per-account session', async () => {
    const prepareSessionResume = vi.fn()
    stubPreparation(prepareSessionResume)
    const current = session({
      codexHome: '/home/user/.orca/codex-accounts/account-1/home',
      executionHostId: 'ssh:server-1' as AiVaultSession['executionHostId']
    })

    await expect(prepareAiVaultSessionForResume(current)).resolves.toBe(current)
    expect(prepareSessionResume).not.toHaveBeenCalled()
  })
})

function stubPreparation(prepareSessionResume: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('window', { api: { aiVault: { prepareSessionResume } } })
}

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:codex:session-1:/tmp/rollout.jsonl',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Legacy session',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/tmp/rollout.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-20T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: "codex resume 'session-1'",
    subagent: null,
    ...overrides
  }
}
