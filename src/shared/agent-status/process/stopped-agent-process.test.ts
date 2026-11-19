import { expect, it } from 'vitest'
import { findStoppedAgentProcess } from './stopped-agent-process'

const row = (pid: number, pgid: number, stat: string, command: string) => ({
  pid,
  ppid: 1,
  pgid,
  tpgid: 7,
  stat,
  command
})

it('finds the agent that job control stopped behind the foreground program', () => {
  const rows = [row(1, 1, 'Ss', '-zsh'), row(5, 5, 'T', 'claude'), row(7, 7, 'S+', 'cat')]
  expect(findStoppedAgentProcess(rows, 7)).toEqual({ pid: 5, agent: 'claude' })
})

it('a running, exited or non-agent process is not a stopped agent', () => {
  expect(findStoppedAgentProcess([row(5, 5, 'S', 'claude'), row(7, 7, 'S+', 'cat')], 7)).toBeNull()
  expect(findStoppedAgentProcess([row(5, 5, 'TZ', 'claude'), row(7, 7, 'S+', 'cat')], 7)).toBeNull()
  expect(findStoppedAgentProcess([row(5, 5, 'T', 'vim'), row(7, 7, 'S+', 'cat')], 7)).toBeNull()
})
