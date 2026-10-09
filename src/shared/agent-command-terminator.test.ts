import { describe, expect, it } from 'vitest'
import { findAgentTerminatorStart, isAgentExecutableToken } from './agent-command-terminator'

const terminatorOf = (command: string, shell: 'posix' | 'powershell' | 'cmd' = 'posix') =>
  findAgentTerminatorStart(command, shell, ['codex'])

describe('findAgentTerminatorStart', () => {
  it('finds the terminator the agent itself carries', () => {
    const command = 'codex --profile work -- literal'
    expect(terminatorOf(command)).toBe(command.indexOf(' -- ') + 1)
  })

  it('ignores a wrapper terminator ahead of the agent', () => {
    expect(terminatorOf('mise exec -- codex')).toBeNull()
    expect(terminatorOf('sudo -u dev -- codex')).toBeNull()
  })

  it('picks the agent terminator behind a wrapper terminator', () => {
    const command = 'mise exec -- codex --profile work -- literal'
    expect(terminatorOf(command)).toBe(command.lastIndexOf(' -- ') + 1)
  })

  it('does not take an argument ending in the agent name for the executable', () => {
    expect(terminatorOf('ssh -i ~/.ssh/codex devbox -- codex')).toBeNull()
  })

  it('falls back to a basename match when a wrapper has no terminator of its own', () => {
    const command = 'CODEX_HOME=/tmp/x uv run codex -- literal'
    expect(terminatorOf(command)).toBe(command.indexOf(' -- ') + 1)
  })

  it('prefers the last basename match when a wrapper option value shares the agent name', () => {
    const command = 'ssh -i ~/.ssh/codex -- devbox codex -- literal'
    expect(terminatorOf(command)).toBe(command.lastIndexOf(' -- ') + 1)
  })

  it('returns null when the command carries no terminator or no agent', () => {
    expect(terminatorOf('codex --profile work')).toBeNull()
    expect(terminatorOf("bash -c 'x -- y'")).toBeNull()
  })

  it('fails open on syntax a splice could cut', () => {
    expect(terminatorOf('codex -- a; echo --')).toBeNull()
    expect(terminatorOf('codex -- "unterminated')).toBeNull()
    expect(terminatorOf('& codex --% -- x', 'powershell')).toBeNull()
  })
})

describe('isAgentExecutableToken', () => {
  it('matches by basename with or without a Windows launcher extension', () => {
    expect(isAgentExecutableToken('/usr/local/bin/codex', ['codex'])).toBe(true)
    expect(isAgentExecutableToken('C:\\tools\\Codex.CMD', ['codex'])).toBe(true)
    expect(isAgentExecutableToken('codex-nightly', ['codex'])).toBe(false)
  })
})
