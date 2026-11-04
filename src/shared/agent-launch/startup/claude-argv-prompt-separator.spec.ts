import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { recognizeAgentProcessFromCommandLine } from '../../agent-status/process/agent-process-recognition'
import { tokenizeCommandLine } from '../../agent-status/process/agent-command-line-entrypoint'

describe("Claude's argv prompt separator", () => {
  /**
   * The launch command Claude would be started with for `prompt`.
   *
   * @param claude A custom launch command, omitted to use the plain `claude` binary.
   */
  function launchCommandFor(prompt: string, claude?: string): string | undefined {
    return buildAgentStartupPlan({
      agent: 'claude',
      prompt,
      cmdOverrides: claude === undefined ? {} : { claude },
      platform: 'darwin'
    })?.launchCommand
  }

  it('keeps a launched Claude recognizable when its prompt mentions -p', () => {
    // Why: the process table joins argv without quotes, so prompt words reach the headless-flag scan.
    const processTableLine = tokenizeCommandLine(
      launchCommandFor('When done, run mkdir -p ~/orca/handoffs/x') ?? ''
    ).join(' ')
    expect(recognizeAgentProcessFromCommandLine(processTableLine)?.agent).toBe('claude')
  })

  it('adds -- only when the Claude command does not already end option parsing', () => {
    expect(launchCommandFor('Fix the bug')).toBe("claude -- 'Fix the bug'")
    expect(launchCommandFor('Fix the bug', 'claude-wrapper --')).toBe(
      "claude-wrapper -- 'Fix the bug'"
    )
    // A required option's `--` value is not a terminator.
    expect(launchCommandFor('Fix the bug', "claude --system-prompt '--'")).toBe(
      "claude --system-prompt '--' -- 'Fix the bug'"
    )
  })
})
