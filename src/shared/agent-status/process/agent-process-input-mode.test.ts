import { expect, it } from 'vitest'
import { observedAgentInputMode } from './agent-process-input-mode'

it.each([
  { argv: ['claude', 'mcp', 'serve'], expected: 'noninteractive' },
  { argv: ['claude', '--append-system-prompt', '', 'mcp', 'serve'], expected: 'noninteractive' },
  { argv: ['claude', '--append-system-prompt=', 'mcp', 'serve'], expected: 'noninteractive' },
  { argv: ['claude', '--append-system-prompt', 'mcp', 'serve'], expected: undefined },
  { argv: ['claude', '--append-system-prompt', ''], expected: undefined },
  { argv: ['claude', '--unknown-option', 'mcp', 'serve'], expected: undefined },
  { argv: ['claude', '--', 'mcp', 'serve'], expected: undefined }
])('preserves application argument roles: $argv', ({ argv, expected }) => {
  expect(observedAgentInputMode('/bin/claude', argv, true)).toBe(expected)
})

it('requires a known executable or literal Node package entrypoint', () => {
  expect(
    observedAgentInputMode(
      '/bin/node',
      ['node', '/app/node_modules/@anthropic-ai/claude-code/cli.js', 'mcp', 'serve'],
      true
    )
  ).toBe('noninteractive')
  expect(observedAgentInputMode('/bin/node', ['node', '-e', 'mcp serve'], true)).toBeUndefined()
  expect(
    observedAgentInputMode('/bin/node', ['node', '/app/cli.js', 'mcp', 'serve'], true)
  ).toBeUndefined()
  expect(observedAgentInputMode('/bin/2.1.322', ['claude', 'mcp', 'serve'], false)).toBeUndefined()
  expect(observedAgentInputMode('/bin/2.1.322', ['claude', 'mcp', 'serve'], true)).toBe(
    'noninteractive'
  )
  expect(observedAgentInputMode('/bin/sh', ['claude', 'mcp', 'serve'], true)).toBeUndefined()
})
