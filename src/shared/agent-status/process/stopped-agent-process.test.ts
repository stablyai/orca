import { expect, it } from 'vitest'
import { findStoppedAgents } from './stopped-agent-process'

const row = (pid: number, pgid: number, stat: string, command: string) => ({
  pid,
  ppid: 1,
  pgid,
  tpgid: 7,
  stat,
  command
})
const shell = row(1, 1, 'Ss', '-zsh')
const front = row(7, 7, 'S+', 'cat')

it('finds every agent kind that job control stopped behind the foreground program', () => {
  expect(findStoppedAgents([shell, row(5, 5, 'T', 'claude'), front], 7)).toEqual(['claude'])
  expect(
    findStoppedAgents([shell, row(5, 5, 'T', 'claude'), row(6, 6, 'T', 'codex'), front], 7)
  ).toEqual(['claude', 'codex'])
  expect(
    findStoppedAgents(
      [shell, row(5, 5, 'T', '/Users/me/.local/share/claude/versions/2.1.323'), front],
      7
    )
  ).toEqual(['claude'])
})

it('an interactive Codex whose option value reads `exec` is still a stopped agent', () => {
  for (const interactive of [
    'codex --profile exec',
    'codex --remote-auth-token-env exec --remote ws://localhost:9999',
    'codex --some-new-option exec'
  ]) {
    expect(findStoppedAgents([shell, row(5, 5, 'T', interactive), front], 7)).toEqual(['codex'])
  }
})

it('a running, exited or non-agent process is not a stopped agent', () => {
  expect(findStoppedAgents([row(5, 5, 'S', 'claude'), front], 7)).toEqual([])
  expect(findStoppedAgents([row(5, 5, 'TZ', 'claude'), front], 7)).toEqual([])
  expect(findStoppedAgents([row(5, 5, 'T', 'vim'), front], 7)).toEqual([])
  expect(findStoppedAgents([row(5, 5, 'T', 'claude -p "summarize the diff"'), front], 7)).toEqual(
    []
  )
})
