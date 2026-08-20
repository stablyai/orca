import { describe, expect, it } from 'vitest'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'

describe('buildFakeAgentCommandOverride', () => {
  it('invokes a quoted Windows command path through PowerShell', () => {
    expect(
      buildFakeAgentCommandOverride("C:\\Users\\Jane Doe\\Temp\\fake agent's\\codex.cmd", 'win32')
    ).toBe("& 'C:\\Users\\Jane Doe\\Temp\\fake agent''s\\codex.cmd'")
  })

  it('quotes a POSIX command path', () => {
    expect(buildFakeAgentCommandOverride("/tmp/fake agent's/codex", 'darwin')).toBe(
      "'/tmp/fake agent'\"'\"'s/codex'"
    )
  })
})
