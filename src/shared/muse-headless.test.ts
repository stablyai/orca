import { describe, expect, it } from 'vitest'
import {
  buildMuseExecArgs,
  isMuseHeadlessCommand,
  sanitizeLogOutput
} from './muse-headless'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('muse agent registration and separation of modes', () => {
  it('recognizes muse as a valid TuiAgent', () => {
    expect(isTuiAgent('muse')).toBe(true)
    expect(TUI_AGENT_DISPLAY_NAMES.muse).toBe('Meta Muse')
  })

  it('uses interactive binary "muse" and NEVER "muse exec" as persistent launchCmd', () => {
    const config = TUI_AGENT_CONFIG.muse
    expect(config.launchCmd).toBe('muse')
    expect(config.detectCmd).toBe('muse')
    expect(config.expectedProcess).toBe('muse')
    expect(config.promptInjectionMode).toBe('argv')
    expect(config.argvPromptSeparator).toBe('--')
    expect(config.launchCmd).not.toContain('exec')
  })

  it('builds interactive TUI startup command with prompt and -- separator', () => {
    const plan = buildAgentStartupPlan({
      agent: 'muse',
      prompt: 'Fix the bug in parser',
      cmdOverrides: {},
      platform: 'linux'
    })
    expect(plan).not.toBeNull()
    expect(plan?.launchCommand).toBe("muse -- 'Fix the bug in parser'")
    expect(plan?.expectedProcess).toBe('muse')
  })

  it('distinguishes between interactive TUI and headless one-shot commands', () => {
    expect(isMuseHeadlessCommand('muse')).toBe(false)
    expect(isMuseHeadlessCommand('muse -- "prompt"')).toBe(false)
    expect(isMuseHeadlessCommand(['muse', '--', 'prompt'])).toBe(false)

    expect(isMuseHeadlessCommand('muse exec "prompt"')).toBe(true)
    expect(isMuseHeadlessCommand('muse exec')).toBe(true)
    expect(isMuseHeadlessCommand(['muse', 'exec', 'prompt'])).toBe(true)
    expect(isMuseHeadlessCommand(['exec', 'prompt'])).toBe(true)
  })
})

describe('muse headless argument builder and security', () => {
  it('builds structured argv array preserving spaces, quotes, and special characters', () => {
    const trickyPrompt = 'Fix issue #123: "unquoted" & $VAR `cmd` <stdio> \'single\''
    const argv = buildMuseExecArgs(trickyPrompt)
    expect(argv).toEqual(['exec', trickyPrompt])
  })

  it('appends extra flags before the positional prompt', () => {
    const argv = buildMuseExecArgs('run task', ['--provider', 'echo', '--yolo'])
    expect(argv).toEqual(['exec', '--provider', 'echo', '--yolo', 'run task'])
  })

  it('sanitizes credentials and tokens from logs and stderr', () => {
    const rawError = 'Error: authentication failed for meta_api_key="EAABxyz1234567890abcdef" token=secret_token_1234567'
    const sanitized = sanitizeLogOutput(rawError)
    expect(sanitized).not.toContain('EAABxyz1234567890abcdef')
    expect(sanitized).not.toContain('secret_token_1234567')
    expect(sanitized).toContain('[SANITIZADO]')
  })
})
