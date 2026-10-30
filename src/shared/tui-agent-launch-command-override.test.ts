import { describe, expect, it } from 'vitest'
import { structuredAgentCommandToken } from './tui-agent-launch-command-override'

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
})
