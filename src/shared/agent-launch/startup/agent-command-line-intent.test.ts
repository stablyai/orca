import { expect, it } from 'vitest'
import { prepareShellNativeAgentLaunch } from './codex-startup-image-command'
import {
  getAgentLaunchCommandToken,
  recognizeAgentLaunchCommand
} from './agent-command-line-intent'

it("recognizes a PowerShell launch of a quoted program path, such as Orca's own copy", () => {
  expect(
    recognizeAgentLaunchCommand("& 'C:\\Users\\a b\\orca\\claude.exe' --resume 'x'")?.agent
  ).toBe('claude')
})

it('recognizes the same Claude agent before and after POSIX launch preparation', () => {
  const invocation = '/opt/orca/claude --resume abc'
  const prepared = prepareShellNativeAgentLaunch(invocation, 'posix', false)
  expect(
    [invocation, prepared].map((command) => recognizeAgentLaunchCommand(command)?.agent)
  ).toEqual(['claude', 'claude'])
})

it('returns the decoded executable for capability probes', () => {
  expect(
    getAgentLaunchCommandToken("'/Users/O'\"'\"'Brien/orca/opencode' --model x", 'posix')
  ).toBe("/Users/O'Brien/orca/opencode")
  expect(
    getAgentLaunchCommandToken(
      "& 'C:\\Users\\O''Brien\\orca\\opencode.exe' --model x",
      'powershell'
    )
  ).toBe("C:\\Users\\O'Brien\\orca\\opencode.exe")
})
