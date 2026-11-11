import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentStatusStore } from './agent-status/store/agent-status-store'
import type { ProcessTableRow } from './process-table-snapshot'
import { TmuxAgentHookOwner } from './tmux-agent-hook-owner'
import type { TmuxManagedPty } from './tmux-agent-hook-contract'

const paneKey = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
const root: TmuxManagedPty = {
  pid: 100,
  incarnation: 'first',
  scope: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace',
    workspaceKind: 'folder'
  }
}
const rows: ProcessTableRow[] = [
  {
    pid: 100,
    ppid: 1,
    pgid: 100,
    tpgid: 101,
    tty: 'pts/1',
    stat: 'S',
    startTime: 'root',
    command: '/bin/bash'
  },
  {
    pid: 101,
    ppid: 100,
    pgid: 101,
    tpgid: 101,
    tty: 'pts/1',
    stat: 'S+',
    startTime: 'client',
    command: '/usr/bin/tmux attach'
  }
]
function fixture() {
  let now = 1000
  let selected = '%0'
  let unverifiable = false
  let noClient = false
  let current: TmuxManagedPty | null = root
  let retired = false
  const store = createAgentStatusStore({ epoch: 'tmux-test', mode: 'authority' })
  const publish = vi.fn()
  const unavailable = vi.fn()
  const probe = vi.fn(async (_socket: string, _roots: readonly number[]) =>
    unverifiable ? null : { clients: noClient ? [] : [{ pid: 101, pane: selected }], rows }
  )
  const owner = new TmuxAgentHookOwner({
    store: () => store,
    getRoot: async () => current,
    publish,
    unavailable,
    probe,
    now: () => now,
    isRetired: () => retired
  })
  const ingest = (pane: string, event: string, prompt: string) =>
    owner.ingest(
      'opencode',
      {
        paneKey,
        worktreeId: 'workspace',
        tmux: { socket: '/tmp/test.sock', pane },
        payload: { hook_event_name: event, prompt }
      },
      'dev'
    )
  return {
    store,
    publish,
    unavailable,
    probe,
    owner,
    ingest,
    advance: () => {
      now += 1000
    },
    select: (pane: string) => {
      selected = pane
    },
    detach: () => {
      noClient = true
    },
    disconnect: () => {
      unverifiable = true
      current = null
    },
    replace: () => {
      current = { ...root, incarnation: 'second' }
    },
    retire: () => {
      retired = true
    }
  }
}
const owners: TmuxAgentHookOwner[] = []
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.stop()
  }
})
function setup() {
  const f = fixture()
  owners.push(f.owner)
  return f
}

describe('tmux canonical hook ownership', () => {
  it('rejects a hook retired while authenticated PTY resolution is pending', async () => {
    const f = setup()
    const ingest = f.ingest('%0', 'SessionBusy', 'late hook')
    f.retire()
    await ingest
    expect(f.store.getParents()).toHaveLength(0)
    expect(f.publish).not.toHaveBeenCalled()
  })
})
