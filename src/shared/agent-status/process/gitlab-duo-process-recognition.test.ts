import { describe, expect, it } from 'vitest'
import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'

// glab execs its managed duo binary, so only `duo` or the full `glab duo cli` launch names the agent.
describe('GitLab Duo process recognition', () => {
  it('recognizes the duo binary but not every glab process', () => {
    expect(recognizeAgentProcess('duo')?.agent).toBe('gitlab-duo')
    expect(recognizeAgentProcess('glab')).toBeNull()
  })

  it.each([
    'glab duo cli',
    'glab duo cli --goal "fix the tests"',
    '/opt/homebrew/bin/glab duo cli --model claude_sonnet_5_5 --goal run',
    'glab duo cli --startup-cards false',
    'glab duo cli --skill review',
    '"/Users/me/Library/Application Support/glab-cli/bin/duo" --skill review',
    '"/Users/me/Library/Application Support/glab-cli/bin/duo" --dangerously-skip-permissions'
  ])('claims the interactive TUI for %s', (line) => {
    expect(recognizeAgentProcessFromCommandLine(line)?.agent).toBe('gitlab-duo')
  })

  it.each(['glab mr list', 'glab duo ask "how do I rebase"', 'glab ci view'])(
    'ignores unrelated glab commands like %s',
    (line) => {
      expect(
        recognizeAgentProcessFromCommandLine(line, { includeHeadlessOneShot: true })
      ).toBeNull()
    }
  )

  it.each([
    'glab duo cli run --goal "fix the tests"',
    'glab duo cli --model claude_sonnet_5_5 run --goal x',
    'glab duo cli --skill review run --goal x',
    'glab duo cli update',
    'glab duo cli --help',
    'duo export --output session.json'
  ])('does not claim interactive ownership for %s', (line) => {
    expect(recognizeAgentProcessFromCommandLine(line)).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(line, { includeHeadlessOneShot: true })?.agent
    ).toBe('gitlab-duo')
  })
})
