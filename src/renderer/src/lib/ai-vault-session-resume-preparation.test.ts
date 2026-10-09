import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import {
  dropDeletedSshResumeCwd,
  prepareAiVaultSessionForFork,
  prepareAiVaultSessionForResume
} from './ai-vault-session-resume-preparation'

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

  it('does not prepare a legacy CLI resume for a native structured session', async () => {
    const prepareSessionResume = vi.fn()
    stubPreparation(prepareSessionResume)
    const native = session({
      codexHome: '/tmp/orca/codex-runtime-home/home',
      structuredSession: { sessionId: 'session-1', workspaceId: 'worktree-1' }
    })

    await expect(prepareAiVaultSessionForResume(native)).resolves.toBe(native)
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

describe('prepareAiVaultSessionForFork', () => {
  // A fork of a chat-owned conversation must run under the selected account, as a resume does.
  it('repins a chat-owned per-account session, asking the host as a fork', async () => {
    const prepareSessionResume = vi.fn().mockResolvedValue({
      useRealCodexHome: false,
      substituteCodexHome: '/tmp/orca/codex-accounts/account-2/home'
    })
    stubPreparation(prepareSessionResume)
    const owned = session({
      codexHome: '/tmp/orca/codex-accounts/account-1/home',
      structuredSession: { sessionId: 'session-1', workspaceId: 'worktree-1' }
    })

    const prepared = await prepareAiVaultSessionForFork(owned)

    expect(prepared.codexHome).toBe('/tmp/orca/codex-accounts/account-2/home')
    expect(prepareSessionResume).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: owned.sessionId,
      filePath: owned.filePath,
      codexHome: owned.codexHome,
      executionHostId: 'local',
      fork: true
    })
  })

  it('does not ask the host for a home that needs no preparation', async () => {
    const prepareSessionResume = vi.fn()
    stubPreparation(prepareSessionResume)
    const owned = session({
      agent: 'claude',
      codexHome: null,
      structuredSession: { sessionId: 'session-1', workspaceId: 'worktree-1' }
    })

    await expect(prepareAiVaultSessionForFork(owned)).resolves.toBe(owned)
    expect(prepareSessionResume).not.toHaveBeenCalled()
  })
})

describe('dropDeletedSshResumeCwd', () => {
  it('leaves a live SSH session alone, scanner command and all', async () => {
    const pathExists = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', { api: { fs: { pathExists } } })
    const remote = session({ executionHostId: 'ssh:server-1', cwd: '/home/ada/wt/feat-x' })

    // Why: dropping the cwd here would strand every ordinary remote resume at the workspace root.
    await expect(dropDeletedSshResumeCwd(remote)).resolves.toBe(remote)
    expect(pathExists).toHaveBeenCalledWith({
      filePath: '/home/ada/wt/feat-x',
      connectionId: 'server-1'
    })
  })

  it('never probes a host for a local session', async () => {
    const pathExists = vi.fn()
    vi.stubGlobal('window', { api: { fs: { pathExists } } })
    const local = session({ cwd: '/repo' })

    await expect(dropDeletedSshResumeCwd(local)).resolves.toBe(local)
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('keeps the recorded folder when the SSH host cannot answer', async () => {
    const pathExists = vi.fn().mockRejectedValue(new Error('CONNECTION_LOST'))
    vi.stubGlobal('window', { api: { fs: { pathExists } } })
    const remote = session({ executionHostId: 'ssh:server-1', cwd: '/home/ada/wt/feat-x' })

    // Why: losing the host is not evidence the folder is gone (ssh-execution-boundary.md).
    await expect(dropDeletedSshResumeCwd(remote)).resolves.toBe(remote)
    expect(pathExists).toHaveBeenCalled()
  })

  it('keeps the recorded folder for an agent that can only resume there', async () => {
    const pathExists = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', { api: { fs: { pathExists } } })
    const kimi = session({ agent: 'kimi', executionHostId: 'ssh:server-1', cwd: '/home/ada/wt/x' })

    // Why: kimi-cli 1.52 silently opens a new empty session with the same id from any other folder.
    await expect(dropDeletedSshResumeCwd(kimi)).resolves.toBe(kimi)
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
