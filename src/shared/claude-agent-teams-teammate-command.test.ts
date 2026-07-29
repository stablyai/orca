import { describe, expect, it } from 'vitest'
import { parseTeammateCommand } from './claude-agent-teams-teammate-command'

describe('parseTeammateCommand', () => {
  it('splits a POSIX cd/env prefix off the real command', () => {
    expect(
      parseTeammateCommand('cd /repo && env CLAUDECODE=1 claude --agent-id a --teammate-mode auto')
    ).toEqual({
      cwd: '/repo',
      env: { CLAUDECODE: '1' },
      command: 'claude --agent-id a --teammate-mode auto'
    })
  })

  it('unquotes a Windows path containing spaces', () => {
    expect(
      parseTeammateCommand("cd 'C:\\Users\\me\\my repo' && env A=1 B=2 claude --agent-id x")
    ).toEqual({
      cwd: 'C:\\Users\\me\\my repo',
      env: { A: '1', B: '2' },
      command: 'claude --agent-id x'
    })
  })

  it('accepts a cd with no env section', () => {
    expect(parseTeammateCommand('cd /repo && claude --teammate-mode auto')).toEqual({
      cwd: '/repo',
      env: {},
      command: 'claude --teammate-mode auto'
    })
  })

  it('accepts an env section with no cd', () => {
    expect(parseTeammateCommand('env CLAUDECODE=1 claude')).toEqual({
      env: { CLAUDECODE: '1' },
      command: 'claude'
    })
  })

  it('passes an unrecognised command through untouched', () => {
    // Why: only the shapes Claude actually emits are rewritten; anything else keeps
    // today's behavior rather than being reinterpreted. (`cat` is covered separately.)
    expect(parseTeammateCommand('claude --teammate-mode auto')).toEqual({
      env: {},
      command: 'claude --teammate-mode auto'
    })
    expect(parseTeammateCommand('bash -lc "echo hi"')).toEqual({
      env: {},
      command: 'bash -lc "echo hi"'
    })
  })

  it('stops consuming env assignments at the first real argument', () => {
    // Why: `--model=sonnet` looks like an assignment but is part of the command.
    expect(parseTeammateCommand('env A=1 claude --model=sonnet --agent-id b')).toEqual({
      env: { A: '1' },
      command: 'claude --model=sonnet --agent-id b'
    })
  })

  it('preserves the command text verbatim, including quoted arguments', () => {
    // Why: rebuilding by joining tokens would drop the quotes and split the prompt.
    const parsed = parseTeammateCommand('cd /repo && env A=1 claude --prompt "hello world"')
    expect(parsed.command).toBe('claude --prompt "hello world"')
  })

  it('reads quoted env values', () => {
    expect(parseTeammateCommand('env GREETING="hello world" claude')).toEqual({
      env: { GREETING: 'hello world' },
      command: 'claude'
    })
  })

  it('tolerates extra whitespace around the separator', () => {
    expect(parseTeammateCommand('cd /repo   &&   env A=1   claude -x')).toEqual({
      cwd: '/repo',
      env: { A: '1' },
      command: 'claude -x'
    })
  })

  it('returns no command when nothing follows the prefix', () => {
    expect(parseTeammateCommand('cd /repo && env A=1')).toEqual({
      cwd: '/repo',
      env: { A: '1' },
      command: ''
    })
  })

  describe('the cat holding-pane placeholder', () => {
    it('drops it on Windows, where cat resolves to Get-Content and prompts', () => {
      expect(parseTeammateCommand('cat', 'win32')).toEqual({ env: {}, command: '' })
    })

    it('keeps it on POSIX, matching upstream behavior', () => {
      // Why: platform is a parameter so this asserts both branches on any host, rather
      // than passing locally and flipping in CI.
      expect(parseTeammateCommand('cat', 'darwin')).toEqual({ env: {}, command: 'cat' })
      expect(parseTeammateCommand('cat', 'linux')).toEqual({ env: {}, command: 'cat' })
    })

    it('does not affect a real command that merely mentions cat', () => {
      expect(parseTeammateCommand('cat file.txt', 'win32')).toEqual({
        env: {},
        command: 'cat file.txt'
      })
    })
  })

  describe('an env prefix carrying no assignments', () => {
    it('still strips the prefix, since PowerShell has no env command', () => {
      expect(parseTeammateCommand('env claude --flag', 'win32')).toEqual({
        env: {},
        command: 'claude --flag'
      })
    })

    it('strips it after a cd clause too', () => {
      expect(parseTeammateCommand("cd '/repo' && env claude --flag", 'win32')).toEqual({
        cwd: '/repo',
        env: {},
        command: 'claude --flag'
      })
    })

    it('leaves a command that merely starts with the word env alone', () => {
      // `envsubst` shares the prefix but is not the env command.
      expect(parseTeammateCommand('envsubst < t.txt', 'win32')).toEqual({
        env: {},
        command: 'envsubst < t.txt'
      })
    })
  })
})
