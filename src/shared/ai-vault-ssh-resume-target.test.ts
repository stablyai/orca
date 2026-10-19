import { describe, expect, it } from 'vitest'
import { canResumeAiVaultSessionOnSshHost } from './ai-vault-ssh-resume-target'

const WSL_FILE = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\app\\s.jsonl'
const HOST_FILE = '/Users/ada/.claude/projects/app/s.jsonl'

describe('canResumeAiVaultSessionOnSshHost', () => {
  it('accepts a session scanned on the target SSH host', () => {
    expect(
      canResumeAiVaultSessionOnSshHost({
        sessionFilePath: '/home/ada/.claude/projects/app/s.jsonl',
        sessionExecutionHostId: 'ssh:builder',
        targetExecutionHostId: 'ssh:builder'
      })
    ).toBe(true)
  })

  it('refuses a session scanned on another SSH host', () => {
    expect(
      canResumeAiVaultSessionOnSshHost({
        sessionFilePath: WSL_FILE,
        sessionExecutionHostId: 'ssh:other',
        targetExecutionHostId: 'ssh:builder'
      })
    ).toBe(false)
  })

  it('accepts a local WSL-stored transcript, with or without a stamped host', () => {
    for (const sessionExecutionHostId of ['local' as const, null]) {
      expect(
        canResumeAiVaultSessionOnSshHost({
          sessionFilePath: WSL_FILE,
          sessionExecutionHostId,
          targetExecutionHostId: 'ssh:builder'
        })
      ).toBe(true)
    }
  })

  it('refuses a transcript stored on this machine outside WSL', () => {
    expect(
      canResumeAiVaultSessionOnSshHost({
        sessionFilePath: HOST_FILE,
        sessionExecutionHostId: 'local',
        targetExecutionHostId: 'ssh:builder'
      })
    ).toBe(false)
  })

  it('keeps a transcript-referencing Antigravity resume on the transcript host', () => {
    const wslReference =
      '//wsl.localhost/Ubuntu/home/ada/.gemini/antigravity-ide/brain/id/transcript_full.jsonl'
    const sshReference = '/home/ada/.gemini/antigravity-ide/brain/id/transcript_full.jsonl'
    expect(
      canResumeAiVaultSessionOnSshHost({
        sessionFilePath: wslReference,
        sessionExecutionHostId: 'local',
        targetExecutionHostId: 'ssh:builder'
      })
    ).toBe(false)
    expect(
      canResumeAiVaultSessionOnSshHost({
        sessionFilePath: sshReference,
        sessionExecutionHostId: 'ssh:builder',
        targetExecutionHostId: 'ssh:builder'
      })
    ).toBe(true)
    // The CLI resumes by ID, so it keeps the WSL exception.
    expect(
      canResumeAiVaultSessionOnSshHost({
        sessionFilePath: wslReference.replace('antigravity-ide', 'antigravity-cli'),
        sessionExecutionHostId: 'local',
        targetExecutionHostId: 'ssh:builder'
      })
    ).toBe(true)
  })

  it('refuses a runtime-scanned session', () => {
    expect(
      canResumeAiVaultSessionOnSshHost({
        sessionFilePath: WSL_FILE,
        sessionExecutionHostId: 'runtime:devbox',
        targetExecutionHostId: 'ssh:builder'
      })
    ).toBe(false)
  })
})
