import { describe, expect, it } from 'vitest'
import { deriveAiVaultSessionHost, sessionTranscriptIsRemoteOwned } from './ai-vault-session-host'
import { createAiVaultTestSession } from './ai-vault-session-test-session'

describe('sessionTranscriptIsRemoteOwned', () => {
  it('treats SSH and runtime hosts as remote-owned transcripts', () => {
    expect(
      sessionTranscriptIsRemoteOwned(
        createAiVaultTestSession({ id: 'ssh', executionHostId: 'ssh:dev-box' })
      )
    ).toBe(true)
    expect(
      sessionTranscriptIsRemoteOwned(
        createAiVaultTestSession({ id: 'runtime', executionHostId: 'runtime:env-1' })
      )
    ).toBe(true)
    expect(
      sessionTranscriptIsRemoteOwned(
        createAiVaultTestSession({ id: 'local', executionHostId: 'local' })
      )
    ).toBe(false)
  })
})

describe('deriveAiVaultSessionHost', () => {
  it('marks WSL UNC session paths and leaves ordinary paths local', () => {
    expect(
      deriveAiVaultSessionHost(
        createAiVaultTestSession({
          id: 'wsl',
          cwd: String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`,
          filePath: String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude\old.jsonl`
        })
      )
    ).toBe('wsl')
    expect(
      deriveAiVaultSessionHost(
        createAiVaultTestSession({
          id: 'local',
          cwd: '/Users/ada/repo',
          filePath: '/Users/ada/.claude/session.jsonl'
        })
      )
    ).toBe('local')
  })
})
