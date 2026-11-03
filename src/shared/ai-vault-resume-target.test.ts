import { describe, expect, it } from 'vitest'
import { canResumeAiVaultSessionOnTarget } from './ai-vault-resume-target'

describe('ai vault session storage compatibility', () => {
  const hostSessionFile = '/Users/ada/.claude/projects/-Users-ada-repo/session-1.jsonl'
  const windowsHostSessionFile = 'C:\\Users\\ada\\.claude\\projects\\C--repo\\session-1.jsonl'
  const wslSessionFile = '\\\\wsl$\\Ubuntu\\home\\ada\\.claude\\projects\\-home-ada-repo\\s-1.jsonl'
  const wslLocalhostSessionFile =
    '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\-home-ada-repo\\s-1.jsonl'

  it('allows host-stored sessions on local targets only', () => {
    expect(
      canResumeAiVaultSessionOnTarget({ sessionFilePath: hostSessionFile, targetStatus: 'local' })
    ).toBe(true)
    expect(
      canResumeAiVaultSessionOnTarget({ sessionFilePath: hostSessionFile, targetStatus: 'ssh' })
    ).toBe(false)
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: windowsHostSessionFile,
        targetStatus: 'ssh'
      })
    ).toBe(false)
  })

  it('allows WSL-stored sessions on local and SSH targets', () => {
    expect(
      canResumeAiVaultSessionOnTarget({ sessionFilePath: wslSessionFile, targetStatus: 'local' })
    ).toBe(true)
    expect(
      canResumeAiVaultSessionOnTarget({ sessionFilePath: wslSessionFile, targetStatus: 'ssh' })
    ).toBe(true)
  })

  // Native Windows and WSL are both local, but only the matching namespace contains the agent/session (#24408).
  it('resumes a local session only in the namespace that stores it', () => {
    const local = { sessionExecutionHostId: 'local', targetExecutionHostId: 'local' } as const
    const resume = (sessionFilePath: string, targetWslDistro: string | null | undefined) =>
      canResumeAiVaultSessionOnTarget({
        ...local,
        sessionFilePath,
        targetStatus: 'local',
        targetWslDistro
      })

    expect(resume(wslLocalhostSessionFile, null)).toBe(false)
    expect(resume(wslLocalhostSessionFile, 'Debian')).toBe(false)
    expect(resume(wslLocalhostSessionFile, 'ubuntu')).toBe(true)
    expect(resume(windowsHostSessionFile, 'Ubuntu')).toBe(false)
    expect(resume(windowsHostSessionFile, null)).toBe(true)
    // An unknown namespace refuses only what it can prove.
    expect(resume(wslLocalhostSessionFile, undefined)).toBe(true)
    expect(resume(windowsHostSessionFile, undefined)).toBe(true)
  })

  it('allows host-tagged SSH sessions only on the matching SSH target', () => {
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: '/home/ada/.codex/sessions/remote.jsonl',
        sessionExecutionHostId: 'ssh:dev-box',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:dev-box'
      })
    ).toBe(true)
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: '/home/ada/.codex/sessions/remote.jsonl',
        sessionExecutionHostId: 'ssh:dev-box',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:other-box'
      })
    ).toBe(false)
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: '/home/ada/.codex/sessions/remote.jsonl',
        sessionExecutionHostId: 'ssh:dev-box',
        targetStatus: 'local',
        targetExecutionHostId: 'local'
      })
    ).toBe(false)
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: '/home/ada/.codex/sessions/remote.jsonl',
        sessionExecutionHostId: 'ssh:dev-box',
        targetStatus: 'local'
      })
    ).toBe(false)
  })

  it('allows WSL-stored local sessions on any SSH target even with explicit host ids', () => {
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: wslSessionFile,
        sessionExecutionHostId: 'local',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:dev-box'
      })
    ).toBe(true)
  })

  it('allows runtime sessions only on the matching runtime target', () => {
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: '/home/ada/.codex/sessions/remote.jsonl',
        sessionExecutionHostId: 'runtime:env-1',
        targetStatus: 'runtime',
        targetExecutionHostId: 'runtime:env-1'
      })
    ).toBe(true)
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: '/home/ada/.codex/sessions/remote.jsonl',
        sessionExecutionHostId: 'runtime:env-1',
        targetStatus: 'runtime',
        targetExecutionHostId: 'runtime:env-2'
      })
    ).toBe(false)
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: wslSessionFile,
        targetStatus: 'runtime',
        targetExecutionHostId: 'runtime:env-1'
      })
    ).toBe(false)
  })

  it('never allows unknown targets', () => {
    expect(
      canResumeAiVaultSessionOnTarget({ sessionFilePath: hostSessionFile, targetStatus: 'unknown' })
    ).toBe(false)
  })
})
