import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentStatusStore } from './agent-status-store'
import type { ProcessTableRow } from './process-table-snapshot'
import { TmuxAgentHookOwner, type TmuxManagedPty } from './tmux-agent-hook-owner'

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
  it('keeps inactive observations canonical and projects only the attached pane with its original age', async () => {
    const f = setup()
    await f.ingest('%0', 'SessionIdle', 'visible completed turn')
    expect(f.publish.mock.lastCall?.[0].payload.state).toBe('done')
    f.advance()
    await f.ingest('%1', 'PermissionRequest', 'inactive permission')
    expect(f.store.getParents()).toHaveLength(2)
    expect(f.publish).toHaveBeenCalledTimes(1)
    f.advance()
    f.select('%1')
    await f.owner.refresh()
    expect(f.publish.mock.lastCall?.[0].payload.state).toBe('waiting')
    expect(f.publish.mock.lastCall?.[1]).toBe(2000)
    f.advance()
    await f.owner.refresh()
    expect(f.publish).toHaveBeenCalledTimes(2)
    expect(f.publish.mock.lastCall?.[1]).toBe(2000)
  })

  it('clears an unknown selected pane without inventing completion, but retains evidence on lost contact', async () => {
    const f = setup()
    await f.ingest('%0', 'SessionBusy', 'working')
    f.advance()
    f.disconnect()
    await f.owner.refresh()
    expect(f.unavailable).not.toHaveBeenCalled()
    expect(f.store.getParents()).toHaveLength(1)
    const other = setup()
    await other.ingest('%0', 'SessionBusy', 'working')
    other.advance()
    other.select('%9')
    await other.owner.refresh()
    expect(other.unavailable).toHaveBeenCalledWith(
      paneKey,
      expect.objectContaining({ kind: 'pty', paneKey }),
      expect.objectContaining({ source: 'opencode' })
    )
    expect(other.publish).toHaveBeenCalledTimes(1)
  })

  it('clears the attachment on a successful empty client proof while preserving inner observations', async () => {
    const f = setup()
    await f.ingest('%0', 'SessionIdle', 'completed')
    f.advance()
    f.detach()
    await f.owner.refresh()
    expect(f.unavailable).toHaveBeenCalledTimes(1)
    expect(f.store.getParents()).toHaveLength(1)
    f.advance()
    await f.owner.refresh()
    expect(f.unavailable).toHaveBeenCalledTimes(1)
  })

  it('visits every socket through bounded rounds instead of skipping inventories larger than sixteen', async () => {
    const f = setup()
    for (let index = 0; index < 34; index++) {
      await f.owner.ingest(
        'opencode',
        {
          paneKey: `tab-${index}:22222222-2222-4222-8222-222222222222`,
          worktreeId: 'workspace',
          tmux: { socket: `/tmp/socket-${index}`, pane: '%0' },
          payload: { hook_event_name: 'SessionBusy', prompt: 'work' }
        },
        'dev'
      )
    }
    for (let round = 0; round < 3; round++) {
      f.advance()
      await f.owner.refresh()
    }
    expect(new Set(f.probe.mock.calls.map((call) => call[0])).size).toBe(34)
    expect(f.probe).toHaveBeenCalledTimes(49)
  })

  it('retires inner observations on certified root replacement or outer exit', async () => {
    const f = setup()
    await f.ingest('%0', 'SessionBusy', 'working')
    f.advance()
    f.replace()
    await f.owner.refresh()
    expect(f.store.getParents()).toHaveLength(0)
    expect(f.unavailable).toHaveBeenCalledWith(
      paneKey,
      expect.objectContaining({ kind: 'pty', paneKey }),
      expect.objectContaining({ source: 'opencode' })
    )
    const other = setup()
    await other.ingest('%0', 'SessionBusy', 'working')
    other.owner.clearPane(paneKey)
    expect(other.store.getParents()).toHaveLength(0)
    other.retire()
    await other.ingest('%1', 'SessionBusy', 'late event')
    expect(other.store.getParents()).toHaveLength(0)
  })

  it('rejects a hook retired while authenticated PTY resolution is pending', async () => {
    const f = setup()
    const ingest = f.ingest('%0', 'SessionBusy', 'late hook')
    f.retire()
    await ingest
    expect(f.store.getParents()).toHaveLength(0)
    expect(f.publish).not.toHaveBeenCalled()
  })

  it('throttles repeated hooks and coalesces concurrent attachment captures', async () => {
    const f = setup()
    await f.ingest('%0', 'SessionBusy', 'working')
    await Promise.all([
      f.owner.refresh(),
      f.owner.refresh(),
      f.ingest('%1', 'SessionBusy', 'other')
    ])
    expect(f.probe).toHaveBeenCalledTimes(1)
    f.advance()
    await Promise.all([f.owner.refresh(), f.owner.refresh()])
    expect(f.probe).toHaveBeenCalledTimes(2)
  })
})
