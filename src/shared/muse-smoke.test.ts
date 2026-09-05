import { describe, expect, it } from 'vitest'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import { pickTuiAgent } from './tui-agent-selection'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { executeMuseHeadless } from './muse-headless-exec'

describe('ORCA Meta Muse smoke test', () => {
  it('selects Meta Muse through Orca selection and configuration contracts', () => {
    // 1. Agent recognized
    expect(isTuiAgent('muse')).toBe(true)

    // 2. Display name
    expect(TUI_AGENT_DISPLAY_NAMES.muse).toBe('Meta Muse')

    // 3. Selection by Orca pickTuiAgent
    expect(pickTuiAgent('muse', ['muse', 'codex'])).toBe('muse')
    expect(pickTuiAgent(null, ['muse'])).toBe('muse')

    // 4. Interactive persistent launch configuration
    const config = TUI_AGENT_CONFIG.muse
    expect(config.launchCmd).toBe('muse')
    expect(config.expectedProcess).toBe('muse')
    expect(config.promptInjectionMode).toBe('argv')
    expect(config.argvPromptSeparator).toBe('--')

    // 5. Startup plan produced by Orca
    const plan = buildAgentStartupPlan({
      agent: 'muse',
      prompt: 'Responda apenas com a palavra MUSE_OK',
      cmdOverrides: {},
      platform: 'win32'
    })
    expect(plan).not.toBeNull()
    expect(plan?.launchCommand).toBe("muse -- 'Responda apenas com a palavra MUSE_OK'")
    expect(plan?.expectedProcess).toBe('muse')
  })

  it('runs live smoke test and receives expected response MUSE_OK', async () => {
    const result = await executeMuseHeadless({
      prompt: 'Responda apenas com a palavra MUSE_OK',
      extraArgs: ['--trust-workspace'],
      timeoutMs: 30000
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('MUSE_OK')
  }, 45000)
})
