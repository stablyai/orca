import { describe, it, expect } from 'vitest'
import { buildAiVaultResumeCommand, defaultAiVaultResumeArgsTemplate } from './ai-vault-types'

const base = {
  sessionId: 'sess-123',
  cwd: '/work/repo',
  platform: 'darwin' as NodeJS.Platform
}

describe('buildAiVaultResumeCommand', () => {
  it('uses built-in resume flags when no override is set', () => {
    expect(buildAiVaultResumeCommand({ ...base, agent: 'claude' })).toBe(
      "cd '/work/repo' && claude --resume 'sess-123'"
    )
    expect(buildAiVaultResumeCommand({ ...base, agent: 'copilot' })).toBe(
      "cd '/work/repo' && copilot --resume='sess-123'"
    )
  })

  it('keeps the CODEX_HOME prefix and base override together', () => {
    expect(
      buildAiVaultResumeCommand({
        ...base,
        agent: 'codex',
        commandOverride: 'npx codex',
        codexHome: '/home/.codex'
      })
    ).toBe("cd '/work/repo' && CODEX_HOME='/home/.codex' npx codex resume 'sess-123'")
  })

  it('substitutes {{id}} in a resume-args override with the quoted session id', () => {
    expect(
      buildAiVaultResumeCommand({ ...base, agent: 'claude', resumeArgsOverride: '--resume {{id}} --yolo' })
    ).toBe("cd '/work/repo' && claude --resume 'sess-123' --yolo")
  })

  it('appends the session id when the override omits {{id}}', () => {
    expect(
      buildAiVaultResumeCommand({ ...base, agent: 'claude', resumeArgsOverride: 'resume --pick' })
    ).toBe("cd '/work/repo' && claude resume --pick 'sess-123'")
  })

  it('preserves the CODEX_HOME prefix when codex resume flags are overridden', () => {
    expect(
      buildAiVaultResumeCommand({
        ...base,
        agent: 'codex',
        resumeArgsOverride: 'resume {{id}}',
        codexHome: '/home/.codex'
      })
    ).toBe("cd '/work/repo' && CODEX_HOME='/home/.codex' codex resume 'sess-123'")
  })

  it('omits the cd prefix when there is no cwd', () => {
    expect(buildAiVaultResumeCommand({ ...base, cwd: null, agent: 'claude' })).toBe(
      "claude --resume 'sess-123'"
    )
  })
})

describe('defaultAiVaultResumeArgsTemplate', () => {
  it('returns editable flag templates with an {{id}} placeholder', () => {
    expect(defaultAiVaultResumeArgsTemplate('claude')).toBe('--resume {{id}}')
    expect(defaultAiVaultResumeArgsTemplate('codex')).toBe('resume {{id}}')
    expect(defaultAiVaultResumeArgsTemplate('copilot')).toBe('--resume={{id}}')
    expect(defaultAiVaultResumeArgsTemplate('kimi')).toBe('--session {{id}}')
  })
})
