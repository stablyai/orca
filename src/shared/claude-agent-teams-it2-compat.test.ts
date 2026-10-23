import { describe, expect, it } from 'vitest'
import {
  fakePaneIdForIt2Session,
  it2SessionIdForPane,
  parseIt2Command,
  requestsClaudeTeammateModeIterm2
} from './claude-agent-teams-it2-compat'

describe('requestsClaudeTeammateModeIterm2', () => {
  it.each([
    ['claude --teammate-mode iterm2', true],
    ['claude --teammate-mode=iterm2 --model opus', true],
    ['claude --teammate-mode  iterm2', true],
    ['claude --teammate-mode iterm2x', false],
    ['claude --teammate-mode in-process', false],
    ['claude --teammate-mode auto', false],
    ['claude', false]
  ])('%s -> %s', (launch, expected) => {
    expect(requestsClaudeTeammateModeIterm2(launch)).toBe(expected)
  })
})

describe('it2 session ids', () => {
  it('round-trips fake pane ids and rejects foreign ids', () => {
    expect(it2SessionIdForPane('%3')).toBe('orca-3-pane')
    expect(fakePaneIdForIt2Session('orca-3-pane')).toBe('%3')
    expect(fakePaneIdForIt2Session('w0t0p0:orca-3-pane')).toBeNull()
    expect(fakePaneIdForIt2Session('orca-x-pane')).toBeNull()
  })
})

describe('parseIt2Command', () => {
  it('parses the verbs Claude Code issues', () => {
    expect(parseIt2Command(['session', 'list'])).toEqual({ kind: 'list' })
    expect(parseIt2Command(['session', 'split', '-v', '-s', 'orca-1-pane'])).toEqual({
      kind: 'split',
      vertical: true,
      sessionId: 'orca-1-pane'
    })
    expect(parseIt2Command(['session', 'split'])).toEqual({
      kind: 'split',
      vertical: false,
      sessionId: undefined
    })
    expect(parseIt2Command(['session', 'send', '-s', 'orca-2-pane', '\x15'])).toEqual({
      kind: 'send',
      sessionId: 'orca-2-pane',
      text: '\x15'
    })
    expect(
      parseIt2Command(['session', 'run', '-s', 'orca-2-pane', 'cd /r && claude -s x'])
    ).toEqual({ kind: 'run', sessionId: 'orca-2-pane', command: 'cd /r && claude -s x' })
    expect(parseIt2Command(['session', 'close', '-f', '-s', 'orca-2-pane'])).toEqual({
      kind: 'close',
      sessionId: 'orca-2-pane'
    })
  })

  it('throws on verbs outside the iTerm2 backend contract', () => {
    expect(() => parseIt2Command(['session', 'focus'])).toThrow('unsupported it2 command')
    expect(() => parseIt2Command([])).toThrow('unsupported it2 command')
  })
})
