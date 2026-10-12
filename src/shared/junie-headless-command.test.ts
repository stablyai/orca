import { describe, expect, it } from 'vitest'
import { isJunieHeadlessOneShotCommand } from './junie-headless-command'

function tokens(commandLine: string): string[] {
  return commandLine.split(' ')
}

describe('isJunieHeadlessOneShotCommand', () => {
  it.each([
    'junie fix-the-tests',
    'junie --task fix-the-tests',
    'junie --acp true',
    'junie --gateway',
    'junie --gateway-status',
    'junie --gateway-stop',
    'junie --version',
    'junie --help',
    'junie -h',
    // A flag value is consumed, so the trailing positional is still the batch task.
    'junie --model gpt-5 do-the-thing'
  ])('treats %s as a headless one-shot', (commandLine) => {
    expect(isJunieHeadlessOneShotCommand(tokens(commandLine))).toBe(true)
  })

  it.each([
    'junie',
    'junie --prompt fix-the-tests',
    'junie --brave',
    'junie --plan',
    'junie --resume --session-id session-260501-101200-abcd',
    'junie --model gpt-5 --effort high',
    'junie --project /tmp/app -p /tmp/app',
    // `=` forms carry their value inline, so the next token is not swallowed.
    'junie --model=gpt-5 --plan',
    // Value-taking options Orca users put in the per-agent CLI args field: their
    // values must never be mistaken for a batch task.
    'junie --anthropic-api-key sk-x --prompt hi',
    'junie --ide-guidelines /tmp/guidelines.md',
    'junie --mcp-location /tmp/mcp',
    'junie --skill-location /tmp/skills',
    'junie --share-anonymous-statistics false',
    'junie --guidelines-filename GUIDELINES.md',
    'junie --auth token-123',
    'junie -a token-123',
    'junie -c /tmp/cache'
  ])('treats %s as the interactive TUI', (commandLine) => {
    expect(isJunieHeadlessOneShotCommand(tokens(commandLine))).toBe(false)
  })

  it('does not swallow a following flag as an unknown option value', () => {
    // A future boolean flag Orca does not know must not consume `--plan`; the
    // trailing positional still marks the run headless.
    expect(isJunieHeadlessOneShotCommand(tokens('junie --future-flag --plan run-it'))).toBe(true)
  })

  it('reads a boolean flag followed by a positional as a batch task', () => {
    expect(isJunieHeadlessOneShotCommand(tokens('junie --brave fix-the-tests'))).toBe(true)
  })
})
