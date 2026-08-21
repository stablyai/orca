import { describe, expect, it } from 'vitest'
import {
  retargetClaudeAgentTeamsPaneCommand,
  supportsClaudeAgentTeamsPaneCommand
} from './claude-agent-teams-pane-command'

// Verbatim from Claude Code 2.1.238's tmux backend, minus the session ids.
const TEAMMATE_COMMAND =
  "cd 'E:\\Repos\\demo' && env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 " +
  "'C:\\Users\\dev\\.local\\bin\\claude.exe' --agent-name Nova --agent-color blue --model opus"

describe('retargetClaudeAgentTeamsPaneCommand', () => {
  it('re-spells the teammate launch for PowerShell', () => {
    expect(retargetClaudeAgentTeamsPaneCommand(TEAMMATE_COMMAND, 'powershell')).toBe(
      "Set-Location 'E:\\Repos\\demo'; " +
        "$env:CLAUDECODE = '1'; " +
        "$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'; " +
        "& 'C:\\Users\\dev\\.local\\bin\\claude.exe' '--agent-name' 'Nova' " +
        "'--agent-color' 'blue' '--model' 'opus'"
    )
  })

  it('leaves sh-speaking panes alone', () => {
    expect(retargetClaudeAgentTeamsPaneCommand(TEAMMATE_COMMAND, 'posix')).toBeNull()
  })

  it('declines cmd rather than emitting quoting it cannot carry', () => {
    expect(supportsClaudeAgentTeamsPaneCommand('cmd')).toBe(false)
    expect(retargetClaudeAgentTeamsPaneCommand(TEAMMATE_COMMAND, 'cmd')).toBeNull()
    expect(supportsClaudeAgentTeamsPaneCommand('powershell')).toBe(true)
    expect(supportsClaudeAgentTeamsPaneCommand('posix')).toBe(true)
  })

  it('keeps the holding pane blocking instead of prompting for a Get-Content path', () => {
    expect(retargetClaudeAgentTeamsPaneCommand('cat', 'powershell')).toBe('Wait-Event')
  })

  it('handles a bare command with neither prefix', () => {
    expect(retargetClaudeAgentTeamsPaneCommand('sleep 1', 'powershell')).toBe("& 'sleep' '1'")
  })

  it('keeps the cd prefix optional', () => {
    expect(retargetClaudeAgentTeamsPaneCommand('env A=1 claude', 'powershell')).toBe(
      "$env:A = '1'; & 'claude'"
    )
  })

  it('doubles apostrophes in values it interpolates', () => {
    expect(
      retargetClaudeAgentTeamsPaneCommand("cd '/it'\"'\"'s here' && claude", 'powershell')
    ).toBe("Set-Location '/it''s here'; & 'claude'")
  })

  it('declines a command carrying an operator it does not model', () => {
    expect(
      retargetClaudeAgentTeamsPaneCommand("cd '/repo' && claude | tee log", 'powershell')
    ).toBeNull()
  })

  it('declines an unbalanced quote instead of guessing', () => {
    expect(retargetClaudeAgentTeamsPaneCommand("cd '/repo", 'powershell')).toBeNull()
  })
})
