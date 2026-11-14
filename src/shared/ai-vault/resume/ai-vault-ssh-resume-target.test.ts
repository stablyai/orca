import { describe, expect, it } from 'vitest'
import { canResumeAiVaultSessionOnSshHost } from './ai-vault-ssh-resume-target'

describe('canResumeAiVaultSessionOnSshHost', () => {
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
})
