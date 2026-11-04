import { describe, expect, it } from 'vitest'
import { agentLaunchedByShellCommand } from './shell-command-agent-launch'

describe('agentLaunchedByShellCommand', () => {
  it.each([
    ['agy -p "fix it" --model flash', 'antigravity'],
    ['cd "C:/work tree" && FOO=1 codex exec "review"', 'codex'],
    ['(cd pkg; claude -p "summarize") > out.txt 2>&1', 'claude']
  ])('recognizes the agent CLI in %s', (command, agent) => {
    expect(agentLaunchedByShellCommand(command)).toBe(agent)
  })

  it.each(['pnpm test src/agy.test.ts', 'echo "agy -p hi"', 'orca orchestration check --wait'])(
    'leaves ordinary commands as shells: %s',
    (command) => {
      expect(agentLaunchedByShellCommand(command)).toBeNull()
    }
  )
})
