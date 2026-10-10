import { describe, expect, it } from 'vitest'
import type { ProcessTableRow } from './process-table-snapshot'
import {
  parseTmuxAttachedClients,
  readTmuxHookPane,
  resolveTmuxClientAttachment
} from './tmux-client-attachment'

const ROOT: ProcessTableRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  tpgid: 101,
  tty: 'ttys149',
  startTime: 'root-start',
  stat: 'S',
  command: '/bin/bash'
}
const CLIENT: ProcessTableRow = {
  ...ROOT,
  pid: 101,
  ppid: 100,
  pgid: 101,
  stat: 'S+',
  startTime: 'client-start',
  command: '/opt/homebrew/bin/tmux -S /private/tmp/status.sock attach'
}

describe('execution-host tmux client attachment', () => {
  it('selects by the outer foreground client, independently of another attached client', () => {
    const clients = [
      { pid: 101, pane: '%0' },
      { pid: 201, pane: '%1' }
    ]
    const otherRoot = { ...ROOT, pid: 200, tpgid: 201, tty: 'ttys150' }
    const otherClient = { ...CLIENT, pid: 201, ppid: 200, pgid: 201, tty: 'ttys150' }
    const rows = [ROOT, CLIENT, otherRoot, otherClient]
    expect(resolveTmuxClientAttachment(100, clients, rows)?.pane).toBe('%0')
    expect(resolveTmuxClientAttachment(200, clients, rows)?.pane).toBe('%1')
  })

  it('accepts tmux replacing the managed shell itself', () => {
    expect(resolveTmuxClientAttachment(101, [{ pid: 101, pane: '%2' }], [CLIENT])?.pane).toBe('%2')
  })

  it.each([
    { tty: 'ttys150' },
    { pgid: 103 },
    { ppid: 999 },
    { startTime: undefined },
    { command: '/bin/bash tmux' },
    { stat: 'T+' }
  ])('refuses a client without the full foreground attachment proof: %j', (changes) => {
    expect(
      resolveTmuxClientAttachment(
        100,
        [{ pid: 101, pane: '%0' }],
        [ROOT, { ...CLIENT, ...changes }]
      )
    ).toBeNull()
  })

  it('refuses ambiguous clients and broken parent chains', () => {
    expect(
      resolveTmuxClientAttachment(
        100,
        [
          { pid: 101, pane: '%0' },
          { pid: 101, pane: '%1' }
        ],
        [ROOT, CLIENT]
      )
    ).toBeNull()
    const cycle = { ...CLIENT, ppid: 102 }
    expect(
      resolveTmuxClientAttachment(
        100,
        [{ pid: 101, pane: '%0' }],
        [ROOT, cycle, { ...ROOT, pid: 102, ppid: 101 }]
      )
    ).toBeNull()
  })

  it('parses bounded client output without accepting a partial malformed table', () => {
    expect(parseTmuxAttachedClients('101:%0\n201:%1\n')).toEqual([
      { pid: 101, pane: '%0' },
      { pid: 201, pane: '%1' }
    ])
    expect(parseTmuxAttachedClients('101:%0\ngarbage')).toBeNull()
    expect(parseTmuxAttachedClients('')).toEqual([])
  })

  it('accepts a socket containing commas but refuses malformed provider metadata', () => {
    expect(readTmuxHookPane({ socket: '/tmp/a,b.sock', pane: '%1' })).toEqual({
      socket: '/tmp/a,b.sock',
      pane: '%1'
    })
    expect(readTmuxHookPane({ socket: 'relative.sock', pane: '%1' })).toBeNull()
    expect(readTmuxHookPane({ socket: '/tmp/x\n.sock', pane: '%1' })).toBeNull()
    expect(readTmuxHookPane({ socket: '/tmp/x.sock', pane: '%1;run' })).toBeNull()
  })
})
