import { describe, expect, it } from 'vitest'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('released Reasonix interactive contract', () => {
  it.each([
    'reasonix',
    'reasonix chat',
    'reasonix code',
    'reasonix --continue',
    'reasonix --resume abc',
    'reasonix --model run',
    'reasonix --model -v',
    'reasonix --dir serve',
    'reasonix --resume run',
    'node.exe C:\\x\\node_modules\\reasonix\\bin\\reasonix.js --model run',
    'node /x/node_modules/reasonix/bin/reasonix.js --model run'
  ])('recognizes %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)?.agent).toBe('reasonix')
  })
  it.each([
    'reasonix run task',
    'reasonix -p task',
    'reasonix --model x --print task',
    'reasonix serve',
    'reasonix web',
    'reasonix acp',
    'reasonix --acp',
    'reasonix session list --json',
    'reasonix config telemetry off',
    'reasonix --help',
    'reasonix --version',
    'reasonix -v',
    'node /x/node_modules/reasonix/bin/reasonix.js -v',
    'node --require bootstrap /x/node_modules/reasonix/bin/reasonix.js run task'
  ])('excludes %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
  })
  it('does not recognize an unrelated script named reasonix.js', () => {
    expect(recognizeAgentProcessFromCommandLine('node /workspace/reasonix.js')).toBeNull()
  })
  it.each(['darwin', 'linux', 'win32'] as const)(
    'delivers the task after TUI startup on %s',
    (platform) => {
      const plan = buildAgentStartupPlan({
        agent: 'reasonix',
        platform,
        prompt: 'Inspect a plain folder',
        cmdOverrides: {}
      })
      expect(plan?.launchCommand).toBe('reasonix')
      expect(plan?.expectedProcess).toBe('reasonix')
      expect(plan?.followupPrompt).toBe('Inspect a plain folder')
    }
  )
})
