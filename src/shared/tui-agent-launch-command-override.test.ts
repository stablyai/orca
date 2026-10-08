import { describe, expect, it } from 'vitest'
import {
  hasExplicitTuiLaunchCommand,
  structuredAgentCommandToken
} from './tui-agent-launch-command-override'

describe('structured agent command tokens', () => {
  it.each([
    ['claude-nightly', 'claude-nightly'],
    ['/opt/tools/claude', '/opt/tools/claude'],
    ['"/opt/my tools/claude"', '/opt/my tools/claude'],
    [String.raw`/opt/my\ tools/claude`, '/opt/my tools/claude'],
    [
      String.raw`"C:\Program Files\Claude\claude.exe"`,
      String.raw`C:\Program Files\Claude\claude.exe`
    ],
    ['~/bin/codex', '~/bin/codex']
  ])('accepts one literal executable %s', (input, token) => {
    expect(structuredAgentCommandToken(input)).toBe(token)
  })

  it.each([
    'npx claude',
    'wrapper --flag',
    'claude;codex',
    '$CLI',
    '"$HOME/bin/claude"',
    '`which claude`',
    'claude | cat',
    'claude\ncodex',
    '"unfinished'
  ])('rejects shell syntax %s', (command) => {
    expect(structuredAgentCommandToken(command)).toBeNull()
  })

  it('leaves other agents and empty overrides unchanged', () => {
    expect(hasExplicitTuiLaunchCommand({ agentCmdOverrides: { kimi: '/bin/kimi' } }, 'kimi')).toBe(
      true
    )
    expect(hasExplicitTuiLaunchCommand({ agentCmdOverrides: { claude: '  ' } }, 'claude')).toBe(
      false
    )
    expect(hasExplicitTuiLaunchCommand(null, 'codex')).toBe(false)
  })
})

describe('hasExplicitTuiLaunchCommand', () => {
  it('treats a whitespace-only command override as no override', () => {
    expect(hasExplicitTuiLaunchCommand({ agentCmdOverrides: { codex: '   ' } }, 'codex')).toBe(
      false
    )
    expect(
      hasExplicitTuiLaunchCommand({ agentCmdOverrides: { codex: 'codex-nightly' } }, 'codex')
    ).toBe(true)
  })
})
