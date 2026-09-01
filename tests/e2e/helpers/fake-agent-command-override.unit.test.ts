import { describe, expect, it } from 'vitest'
import { WINDOWS_GIT_BASH_SHELL } from '../../../src/shared/windows-terminal-shell'
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

  it('drops the PowerShell call operator when the Windows host runs cmd', () => {
    expect(
      buildFakeAgentCommandOverride('C:\\Temp\\fake agent\\codex.cmd', 'win32', 'cmd.exe')
    ).toBe('"C:\\Temp\\fake agent\\codex.cmd"')
  })

  it('uses POSIX quoting when the Windows host runs Git Bash or WSL', () => {
    expect(buildFakeAgentCommandOverride('/tmp/fake agent/codex', 'win32', 'wsl.exe')).toBe(
      "'/tmp/fake agent/codex'"
    )
    expect(
      buildFakeAgentCommandOverride("/tmp/fake agent's/codex", 'win32', WINDOWS_GIT_BASH_SHELL)
    ).toBe("'/tmp/fake agent'\"'\"'s/codex'")
  })
})
