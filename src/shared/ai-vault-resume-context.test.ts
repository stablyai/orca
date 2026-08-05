import { describe, expect, it } from 'vitest'
import { canResumeAiVaultSessionInExecutionContext } from './ai-vault-resume-context'

const WSL_CURSOR_PATH =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor\\chats\\bucket\\session\\meta.json'

describe('canResumeAiVaultSessionInExecutionContext', () => {
  it('isolates native and WSL Cursor sessions', () => {
    expect(
      canResumeAiVaultSessionInExecutionContext({
        agent: 'cursor',
        sessionFilePath: '/home/ada/.cursor/chats/bucket/session/meta.json',
        sessionExecutionHostId: 'local',
        targetStatus: 'local',
        targetExecutionHostId: 'local'
      })
    ).toBe(true)
    expect(
      canResumeAiVaultSessionInExecutionContext({
        agent: 'cursor',
        sessionFilePath: WSL_CURSOR_PATH,
        sessionExecutionHostId: 'local',
        targetStatus: 'local',
        targetExecutionHostId: 'local',
        targetWslDistro: 'ubuntu'
      })
    ).toBe(true)
    expect(
      canResumeAiVaultSessionInExecutionContext({
        agent: 'cursor',
        sessionFilePath: WSL_CURSOR_PATH,
        sessionExecutionHostId: 'local',
        targetStatus: 'local',
        targetExecutionHostId: 'local',
        targetWslDistro: 'Debian'
      })
    ).toBe(false)
    expect(
      canResumeAiVaultSessionInExecutionContext({
        agent: 'cursor',
        sessionFilePath: '/home/ada/.cursor/chats/bucket/session/meta.json',
        sessionExecutionHostId: 'local',
        targetStatus: 'local',
        targetExecutionHostId: 'local',
        targetWslDistro: 'Ubuntu'
      })
    ).toBe(false)
  })

  it('requires the exact SSH or runtime host and matching target kind', () => {
    expect(
      canResumeAiVaultSessionInExecutionContext({
        agent: 'cursor',
        sessionExecutionHostId: 'ssh:dev',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:dev'
      })
    ).toBe(true)
    expect(
      canResumeAiVaultSessionInExecutionContext({
        agent: 'cursor',
        sessionExecutionHostId: 'ssh:dev',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:other'
      })
    ).toBe(false)
    expect(
      canResumeAiVaultSessionInExecutionContext({
        agent: 'cursor',
        sessionExecutionHostId: 'runtime:env-1',
        targetStatus: 'runtime',
        targetExecutionHostId: 'runtime:env-1'
      })
    ).toBe(true)
    expect(
      canResumeAiVaultSessionInExecutionContext({
        agent: 'cursor',
        sessionExecutionHostId: 'runtime:env-1',
        targetStatus: 'ssh',
        targetExecutionHostId: 'runtime:env-1'
      })
    ).toBe(false)
  })

  it('excludes Cursor from the legacy Local-WSL to SSH exception', () => {
    const target = {
      sessionFilePath: WSL_CURSOR_PATH,
      sessionExecutionHostId: 'local' as const,
      targetStatus: 'ssh' as const,
      targetExecutionHostId: 'ssh:dev' as const
    }
    expect(canResumeAiVaultSessionInExecutionContext({ ...target, agent: 'claude' })).toBe(true)
    expect(canResumeAiVaultSessionInExecutionContext({ ...target, agent: 'cursor' })).toBe(false)
  })
})
