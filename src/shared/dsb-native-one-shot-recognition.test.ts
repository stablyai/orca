import { describe, expect, it } from 'vitest'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { selectForegroundProcessCandidate } from './foreground-process-selection'

// Released 6.9.0 PagerArgs single/JSON/file flags, forwarded by outer Commands::Agent.
describe('DeepSeek Build native one-shot identity exclusion', () => {
  it.each([
    'dsb agent -p task',
    'dsb agent -- --print task',
    'deepseek-build agent -- --prompt-file task.txt',
    'deepseek-build agent --single task',
    'dsb agent --print task',
    'dsb agent --prompt-json "[]"',
    'dsb agent --prompt-file /tmp/task.txt',
    'deepseek-build-agent -p task',
    'deepseek-build-agent.exe --print task',
    'deepseek-build-agent --single=task',
    'deepseek-build-agent -ptask',
    'deepseek-build-agent -cp task',
    'deepseek-build-agent -cptask',
    'deepseek-build-agent -p-',
    'deepseek-build-agent -cp--print',
    'dsb agent -p-',
    'dsb agent -cp--print',
    'dsb agent -cp task',
    'dsb run task',
    'deepseek-build-agent --resume saved-session --print task',
    'deepseek-build-agent --resume --prompt-file task.txt',
    'dsb --cwd folder agent --model deepseek-v4-flash --prompt-file task.txt',
    'node --import ./preload.mjs /x/node_modules/@innocarpe/deepseek-build/npm/bin/dsb.js agent --print task',
    '"C:\\Program Files\\nodejs\\node.exe" --require preload.js "C:\\x\\node_modules\\@innocarpe\\deepseek-build\\npm\\bin\\deepseek-build.js" agent --prompt-json=[]'
  ])('does not claim interactive ownership for %s', (line) => {
    expect(recognizeAgentProcessFromCommandLine(line)).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(line, { includeHeadlessOneShot: true })?.agent
    ).toBe('dsb')
  })

  it.each([
    'dsb agent "explain --print and -p"',
    'deepseek-build-agent -- "--print"',
    'dsb agent -- -- "--print"',
    'deepseek-build-agent --model=--print',
    'deepseek-build-agent --rules "use --prompt-file"',
    'deepseek-build-agent --system-prompt "run"',
    'dsb agent --model run',
    'dsb agent --resume saved-session',
    'deepseek-build-agent run',
    'dsb agent run',
    'deepseek-build-agent --leader-socket run',
    'deepseek-build-agent -mp',
    'deepseek-build-agent -rp',
    'deepseek-build-agent -sp',
    'deepseek-build-agent -wp',
    'deepseek-build-agent -cmp',
    'deepseek-build-agent -crp',
    'deepseek-build-agent -csp',
    'deepseek-build-agent -cwp'
  ])('keeps interactive prompts and option values interactive: %s', (line) => {
    expect(recognizeAgentProcessFromCommandLine(line)?.agent).toBe('dsb')
  })

  it('does not select a one-shot native child as interactive foreground', () => {
    expect(
      selectForegroundProcessCandidate([
        {
          pid: 42,
          ppid: 1,
          depth: 1,
          stat: 'S+',
          command: '/tmp/bin/deepseek-build-agent --print task'
        }
      ])
    ).toBeNull()
  })
})
