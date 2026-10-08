import { describe, expect, it } from 'vitest'
import { buildAiVaultResumeCommand } from './ai-vault-resume-command'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'
import { antigravityTranscriptReferencePrompt } from './antigravity-session-origin'
import { normalizeAiVaultResumeFilePath } from './ai-vault-resume-path'

describe('Antigravity transcript reference launch', () => {
  it.each(['antigravity-ide', 'antigravity'])(
    'starts a new conversation for %s and preserves the explicit transcript argument',
    (origin) => {
      const path = `/home/example/.gemini/${origin}/brain/same-id/.system_generated/logs/transcript_full.jsonl`
      const command = buildAiVaultResumeCommand({
        agent: 'antigravity',
        sessionId: 'same-id',
        cwd: null,
        platform: 'linux',
        resumeFilePath: path
      })
      expect(tokenizeCommandLine(command)).toEqual([
        'agy',
        '--prompt-interactive',
        antigravityTranscriptReferencePrompt(path)
      ])
      expect(command).not.toContain('--conversation')
    }
  )
  it('quotes hostile path text as one prompt argument', () => {
    const path = `/tmp/a'$(touch forbidden)/.gemini/antigravity-ide/brain/id/.system_generated/logs/transcript.jsonl`
    const command = buildAiVaultResumeCommand({
      agent: 'antigravity',
      sessionId: 'id',
      cwd: null,
      platform: 'linux',
      resumeFilePath: path,
      shell: 'posix'
    })
    expect(tokenizeCommandLine(command)).toEqual([
      'agy',
      '--prompt-interactive',
      antigravityTranscriptReferencePrompt(path)
    ])
  })
  it('converts the selected WSL transcript into its owning Linux path', () => {
    const path =
      '\\\\wsl.localhost\\Ubuntu\\home\\example\\.gemini\\antigravity-ide\\brain\\id\\.system_generated\\logs\\transcript_full.jsonl'
    const normalized = normalizeAiVaultResumeFilePath(path, 'linux')
    const command = buildAiVaultResumeCommand({
      agent: 'antigravity',
      sessionId: 'id',
      cwd: null,
      platform: 'linux',
      resumeFilePath: path
    })
    expect(tokenizeCommandLine(command)).toEqual([
      'agy',
      '--prompt-interactive',
      antigravityTranscriptReferencePrompt(normalized!)
    ])
    expect(command).not.toContain('wsl.localhost')
  })
  it.each(['cmd', 'powershell', 'posix'] as const)(
    'uses the actual Windows %s shell and preserves CLI resume behavior',
    (shell) => {
      const path =
        'C:\\User data\\.gemini\\antigravity-ide\\brain\\id\\.system_generated\\logs\\transcript_full.jsonl'
      const command = buildAiVaultResumeCommand({
        agent: 'antigravity',
        sessionId: 'id',
        cwd: null,
        platform: 'win32',
        resumeFilePath: path,
        shell
      })
      expect(command).toContain('--prompt-interactive')
      expect(command).not.toContain('--conversation')
      const cli = buildAiVaultResumeCommand({
        agent: 'antigravity',
        sessionId: 'id',
        cwd: null,
        platform: 'win32',
        resumeFilePath: path.replace('antigravity-ide', 'antigravity-cli'),
        shell
      })
      expect(cli).toContain('--conversation')
      expect(cli).not.toContain('--prompt-interactive')
    }
  )
})
