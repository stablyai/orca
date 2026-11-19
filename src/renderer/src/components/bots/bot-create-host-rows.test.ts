import { describe, expect, it } from 'vitest'
import { botCreateHostRows, type BotCreateHostRowsInput } from './bot-create-host-rows'
import { botCreateHosts, type BotCreateHostsInput } from './bot-create-hosts'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

const ready = (hostPlatform: NodeJS.Platform, capabilities: string[] = ['bots.create.v1']) => ({
  status: { hostPlatform, capabilities, remoteControl: { state: 'ready' } }
})

function owner(
  runtimeStatusByEnvironmentId = new Map([
    ['g16', ready('win32')],
    ['windows-2', ready('win32', [])]
  ])
): BotCreateHostsInput {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: botCreateHosts reads only id/name and these status fields.
  return {
    runtimeEnvironments: [
      { id: 'g16', name: 'g16' },
      { id: 'linux-1', name: 'linux 1' },
      { id: 'windows-2', name: 'windows 2' }
    ],
    runtimeStatusByEnvironmentId
  } as unknown as BotCreateHostsInput
}

const input = (over: Partial<BotCreateHostRowsInput> = {}): BotCreateHostRowsInput => ({
  readyAtOpen: null,
  otherAccountOf: () => null,
  updatable: () => false,
  reconnecting: new Set(),
  ...over
})

const shape = (rows: ReturnType<typeof botCreateHostRows>) =>
  rows.map((row) => [row.host.label, row.group, row.meta, row.action])

describe('botCreateHostRows', () => {
  it('puts ready hosts first with their OS and other account, then the rest with only their fix', () => {
    const rows = botCreateHostRows(
      botCreateHosts(owner()),
      input({
        otherAccountOf: (id) => (id === 'runtime:g16' ? 'team@acme.dev' : null),
        updatable: (id) => id === 'windows-2'
      })
    )
    expect(shape(rows.slice(1))).toEqual([
      ['g16', 'ready', 'Windows · as team@acme.dev', null],
      ['linux 1', 'unavailable', null, 'reconnect'],
      ['windows 2', 'unavailable', null, 'update']
    ])
    expect(rows[0].group).toBe('ready')
  })

  it('offers Update only when the update dialog can update it', () => {
    const rows = botCreateHostRows(botCreateHosts(owner()), input())
    expect(shape(rows.filter((row) => row.host.label === 'windows 2'))).toEqual([
      ['windows 2', 'unavailable', null, null]
    ])
  })

  it('keeps groups from when the list opened while a host comes back', () => {
    const readyAtOpen = new Set<ExecutionHostId>(['local', 'runtime:g16'])
    const hosts = botCreateHosts(
      owner(
        new Map([
          ['g16', ready('win32')],
          ['linux-1', ready('linux')]
        ])
      )
    )
    const rows = botCreateHostRows(
      hosts,
      input({ readyAtOpen, reconnecting: new Set(['windows-2']) })
    )
    expect(shape(rows.slice(1))).toEqual([
      ['g16', 'ready', 'Windows', null],
      ['linux 1', 'unavailable', 'Linux', null],
      ['windows 2', 'unavailable', null, 'reconnecting']
    ])
  })
})
