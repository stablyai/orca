import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { recognizeAgentProcessFromCommandLine } from '../../agent-status/process/agent-process-recognition'
import { tokenizeCommandLine } from '../../agent-status/process/agent-command-line-entrypoint'

describe("Claude's argv prompt separator", () => {
  /** Claude's launch command for `prompt`, under an optional command override. */
  function launchCommandFor(prompt: string, claude?: string): string | undefined {
    return buildAgentStartupPlan({
      agent: 'claude',
      prompt,
      cmdOverrides: { claude },
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

  it.each([
    ['claude-wrapper --', "claude-wrapper -- 'Fix the bug'"],
    // A required option's `--` value is not a terminator.
    ["claude --system-prompt '--'", "claude --system-prompt '--' -- 'Fix the bug'"],
    // A wrapper's `--` ends the wrapper's options, not Claude's.
    ['env -- claude', "env -- claude -- 'Fix the bug'"]
  ])('ends Claude options exactly once behind %s', (claude, expected) => {
    expect(launchCommandFor('Fix the bug', claude)).toBe(expected)
  })
})
