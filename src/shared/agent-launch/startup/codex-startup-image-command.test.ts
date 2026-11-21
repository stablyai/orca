import { expect, it } from 'vitest'
import { recognizeAgentProcessFromCommandLine } from '../../agent-status/process/agent-process-recognition'
import {
  unwrapCodexStartupImageCommand,
  withCodexStartupImageCommand
} from './codex-startup-image-command'

const quotedCodex =
  '"C:\\Program Files\\Codex CLI\\bin\\codex.exe" --no-daemon resume \'session-id\''

it('calls a quoted Codex path inside the PowerShell image wrapper (#46114)', () => {
  const wrapped = withCodexStartupImageCommand(quotedCodex, 'powershell')

  expect(wrapped).toContain('try {& "C:\\Program Files\\Codex CLI\\bin\\codex.exe"')
  expect(wrapped).not.toContain('& &')
  expect(unwrapCodexStartupImageCommand(wrapped)).toBe(quotedCodex)
  expect(recognizeAgentProcessFromCommandLine(wrapped)?.agent).toBe('codex')
})

it('calls a single-quoted Codex path without changing the original command', () => {
  const command = "'C:\\Program Files\\Codex CLI\\bin\\codex.exe' --no-daemon resume 'session-id'"
  const wrapped = withCodexStartupImageCommand(command, 'powershell')

  expect(wrapped).toContain("try {& 'C:\\Program Files\\Codex CLI\\bin\\codex.exe'")
  expect(unwrapCodexStartupImageCommand(wrapped)).toBe(command)
  expect(recognizeAgentProcessFromCommandLine(wrapped)?.agent).toBe('codex')
})

it('does not add a second call operator when the command already has one', () => {
  const command = `& ${quotedCodex}`
  const wrapped = withCodexStartupImageCommand(command, 'powershell')

  expect(wrapped).toContain('try { & "C:\\Program Files\\Codex CLI\\bin\\codex.exe"')
  expect(wrapped).not.toContain('try {&')
  expect(wrapped).not.toContain('& &')
  expect(unwrapCodexStartupImageCommand(wrapped)).toBe(command)
})

it('does not add a call operator to an unquoted Codex executable', () => {
  const command = "C:\\Codex\\codex.exe --no-daemon resume 'session-id'"
  const wrapped = withCodexStartupImageCommand(command, 'powershell')

  expect(wrapped).toContain('try { C:\\Codex\\codex.exe')
  expect(wrapped).not.toContain('try {&')
  expect(unwrapCodexStartupImageCommand(wrapped)).toBe(command)
})

it('leaves a bare codex command and a stop-parsing command unwrapped', () => {
  const bare = 'codex --no-daemon resume session-id'
  const stopParsing = `${quotedCodex.slice(0, quotedCodex.indexOf(' '))} --% --no-daemon`

  expect(withCodexStartupImageCommand(bare, 'powershell')).toBe(bare)
  expect(withCodexStartupImageCommand(stopParsing, 'powershell')).toBe(stopParsing)
})

it('does not use the PowerShell call form for cmd or posix', () => {
  expect(withCodexStartupImageCommand(quotedCodex, 'cmd')).toBe(quotedCodex)
  expect(withCodexStartupImageCommand(quotedCodex, 'posix')).not.toContain('try {')
})
