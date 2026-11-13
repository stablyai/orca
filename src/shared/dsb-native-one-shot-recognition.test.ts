import { describe, expect, it } from 'vitest'
import { recognizeAgentProcessFromCommandLine } from './agent-status/process/agent-process-recognition'

// Released 6.9.0 PagerArgs single/JSON/file flags, forwarded by outer Commands::Agent.
describe('DeepSeek Build native one-shot identity exclusion', () => {
  it.each([
    'dsb agent -p task',
    'dsb agent -- --print task',
    'deepseek-build agent --single task',
    'dsb agent --prompt-json "[]"',
    'dsb agent --prompt-file /tmp/task.txt',
    'deepseek-build-agent.exe --print task',
    'deepseek-build-agent --single=task',
    'deepseek-build-agent -ptask',
    'deepseek-build-agent -cptask',
    'dsb run task',
    'deepseek-build-agent --resume --prompt-file task.txt',
    '"C:\\Program Files\\nodejs\\node.exe" --require preload.js "C:\\x\\node_modules\\@innocarpe\\deepseek-build\\npm\\bin\\deepseek-build.js" agent --prompt-json=[]'
  ])('does not claim interactive ownership for %s', (line) => {
    expect(recognizeAgentProcessFromCommandLine(line)).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(line, { includeHeadlessOneShot: true })?.agent
    ).toBe('dsb')
  })

  it.each([
    'dsb agent "explain --print and -p"',
    'dsb agent -- -- "--print"',
    'deepseek-build-agent --model=--print',
    'deepseek-build-agent --system-prompt "run"',
    'dsb agent --resume saved-session',
    'deepseek-build-agent --leader-socket run',
    'deepseek-build-agent -cmp'
  ])('keeps interactive prompts and option values interactive: %s', (line) => {
    expect(recognizeAgentProcessFromCommandLine(line)?.agent).toBe('dsb')
  })
})
