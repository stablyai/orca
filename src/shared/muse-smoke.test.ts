import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildMuseExecArgs } from './muse-headless'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import { pickTuiAgent } from './tui-agent-selection'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { buildAgentStartupPlan } from './tui-agent-startup'

const execFileAsync = promisify(execFile)

const hasMuseInstalled = (() => {
  try {
    const { status } = spawnSync('muse', ['--version'], { stdio: 'ignore' })
    return status === 0
  } catch {
    return false
  }
})()

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

  it.runIf(hasMuseInstalled)(
    'executes offline smoke test using --provider echo without network or credentials',
    async () => {
      const args = buildMuseExecArgs('MUSE_ECHO_SMOKE', ['--provider', 'echo', '--trust-workspace'])
      const { stdout } = await execFileAsync('muse', args, { timeout: 15000 })
      expect(stdout).toContain('MUSE_ECHO_SMOKE')
    }
  )

  it.runIf(process.env.ORCA_MUSE_LIVE_TEST === 'true' && hasMuseInstalled)(
    'runs live smoke test against Meta Muse API when ORCA_MUSE_LIVE_TEST=true',
    async () => {
      const args = buildMuseExecArgs('Responda apenas com a palavra MUSE_OK', ['--trust-workspace'])
      const { stdout } = await execFileAsync('muse', args, { timeout: 45000 })
      expect(stdout).toContain('MUSE_OK')
    },
    60000
  )
})

