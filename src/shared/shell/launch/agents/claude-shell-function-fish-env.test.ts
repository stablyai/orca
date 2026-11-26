import { expect, it } from 'vitest'
import { getFishClaudeShellFunction } from './claude-shell-function'

it('launches fish Claude through command env so a user env function cannot pipe stdout', () => {
  const script = getFishClaudeShellFunction()
  expect(script).toContain(
    'command env -u ORCA_CLAUDE_INJECTED_CONFIG_DIR CLAUDE_CONFIG_DIR="$ORCA_CLAUDE_USER_CONFIG_DIR" claude $argv'
  )
  expect(script).toContain(
    'command env -u CLAUDE_CONFIG_DIR -u ORCA_CLAUDE_INJECTED_CONFIG_DIR claude $argv'
  )
  expect(script).toContain(
    'command env CLAUDE_CONFIG_DIR="$profile" ORCA_CLAUDE_INJECTED_CONFIG_DIR="$profile" claude $argv'
  )
  expect(script.split('\n').filter((line) => /^\s*env(\s|$)/.test(line))).toEqual([])
})
