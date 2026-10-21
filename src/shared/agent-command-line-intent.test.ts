import { expect, it } from 'vitest'
import {
  extractAgentLaunchCommand,
  getAgentLaunchCommandToken,
  getAgentLaunchExecutableName,
  recognizeAgentLaunchCommand
} from './agent-command-line-intent'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from './command-token-scanner'

it.each([
  ['sleep 30 && claude', 'claude'],
  [' sleep 30&&codex "do not sleep 30 && claude"', 'codex "do not sleep 30 && claude"'],
  [
    '/bin/sleep .5 && /usr/bin/sleep 1m && "C:\\Program Files\\Orca\\codex.exe"',
    '"C:\\Program Files\\Orca\\codex.exe"'
  ]
])('extracts only the delayed launch hint from %s', (command, expected) => {
  expect(extractAgentLaunchCommand(command)).toBe(expected)
})

it.each([
  'echo "sleep 30 && claude"',
  'sleep 30 || claude',
  'sleep 30 | claude',
  'sleep 30 & claude',
  'sleep "$DELAY" && claude',
  'sleep 30; claude',
  'sleep-helper 30 && claude',
  'claude "sleep 30 && codex"',
  'sh -c "sleep 30 && claude"'
])('leaves unmodeled shell syntax intact: %s', (command) => {
  expect(extractAgentLaunchCommand(command)).toBe(command)
})

it('bounds prefix scanning without truncating the launch arguments', () => {
  const task = 'x'.repeat(COMMAND_TOKEN_SCAN_MAX_CHARS * 4)
  expect(extractAgentLaunchCommand(`sleep 30 && claude '${task}'`)).toBe(`claude '${task}'`)
  const command = `${' '.repeat(COMMAND_TOKEN_SCAN_MAX_CHARS)}sleep 30 && claude`
  expect(extractAgentLaunchCommand(command)).toBe(command)
})

it('does not turn a waiting shell process into live agent evidence', () => {
  expect(recognizeAgentLaunchCommand('sleep 30 && claude')?.agent).toBe('claude')
  expect(recognizeAgentProcessFromCommandLine('sleep 30 && claude')).toBeNull()
  expect(recognizeAgentProcessFromCommandLine('/bin/zsh -c "sleep 30 && claude"')).toBeNull()
})

it('extracts executable tokens through the shared launch boundary', () => {
  expect(
    getAgentLaunchCommandToken('sleep 30 && "C:\\Program Files\\Orca\\codex.exe" --resume')
  ).toBe('C:\\Program Files\\Orca\\codex.exe')
  expect(getAgentLaunchCommandToken(undefined)).toBe('')
  expect(getAgentLaunchCommandToken('echo "sleep 30 && claude"')).toBe('echo')
})

it.each([
  ['sleep 30 && "C:\\Program Files\\Orca\\Codex.EXE" --resume', 'codex'],
  ['/usr/local/bin/mimo.sh', 'mimo'],
  ['sleep 1 && opencode2.cmd', 'opencode2'],
  [undefined, '']
])('normalizes the launch executable name of %s', (command, expected) => {
  expect(getAgentLaunchExecutableName(command)).toBe(expected)
})

it('preserves headless filtering and interpreter recognition for launch intent', () => {
  expect(recognizeAgentLaunchCommand('sleep 30 && claude -p task')).toBeNull()
  expect(
    recognizeAgentLaunchCommand('sleep 30 && claude -p task', {
      includeHeadlessOneShot: true
    })?.agent
  ).toBe('claude')
  expect(recognizeAgentLaunchCommand('sleep 30 && node /usr/local/bin/codex')?.agent).toBe('codex')
})
