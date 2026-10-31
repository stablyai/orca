import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeCopyHost } from './__fixtures__/fake-copy-host'
import { FakePerforceServer } from './__fixtures__/fake-perforce-server'
import type { HostProcess } from './workspace-copy-host'
import { requireRemovalOptions } from './workspace-copy-arguments'
import { createWorkspaceCopy } from './workspace-copy-create'
import { processesUnder } from './workspace-copy-processes'
import { previewWorkspaceCopyRemoval } from './workspace-copy-removal-preview'
import { removeWorkspaceCopy } from './workspace-copy-remove'

let base: string
let ws: string
let copyRoot: string
let server: FakePerforceServer
let processes: HostProcess[]

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'p4copy-holders-'))
  ws = join(base, 'ws')
  copyRoot = join(base, 'ws.wt', 'one')
  server = new FakePerforceServer()
  server.addStream('//s/main', { 'a.txt': 1 })
  server.addSyncedClient('src', ws, '//s/main')
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'p4config.txt'), 'P4PORT=srv:1666\nP4CLIENT=src\n')
  processes = []
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function copyWithHolders() {
  const host = createFakeCopyHost(server, base, { processes })
  await createWorkspaceCopy(host, ws, { name: 'one' })
  processes.push(
    {
      pid: 10,
      name: 'indexer.exe',
      commandLine: `indexer.exe --workspace ${join(copyRoot, 'Game')}`,
      startedAt: 1000
    },
    {
      pid: 11,
      name: 'Unity.exe',
      // Unity's workers spell the path with forward slashes.
      commandLine: `Unity.exe -projectPath "${copyRoot.replaceAll('\\', '/')}/Game"`,
      startedAt: 2000
    },
    { pid: 12, name: 'other.exe', commandLine: `other.exe ${copyRoot}0`, startedAt: 3000 }
  )
  return host
}

describe('programs holding a copy', () => {
  it('lists them and refuses the delete until the user agrees to end them', async () => {
    const host = await copyWithHolders()
    const preview = await previewWorkspaceCopyRemoval(host, ws, 'one')
    expect(preview.holders?.map((holder) => holder.pid)).toEqual([10, 11])
    expect(preview.blockers.holders).toBe(true)
    expect(preview.processesHoldingFolder).toEqual(['indexer.exe (pid 10)', 'Unity.exe (pid 11)'])

    await expect(removeWorkspaceCopy(host, ws, 'one')).rejects.toThrow(/still have .* open/)
    expect(server.client('src_wt_one')).toBeDefined()
    expect(host.endedPids).toEqual([])

    const removed = await removeWorkspaceCopy(
      host,
      ws,
      'one',
      {
        endHolders: [
          { pid: 10, startedAt: 1000 },
          { pid: 11, startedAt: 2000 }
        ]
      },
      { awaitFolderDeletion: true }
    )
    expect(host.endedPids).toEqual([10, 11])
    expect(removed.clientDeleted).toBe(true)
    expect(existsSync(copyRoot)).toBe(false)
    expect(processes.map((p) => p.pid)).toEqual([12])
  })

  it('ends only the programs the user was shown', async () => {
    const host = await copyWithHolders()
    // Unity's pid now belongs to a process that started later.
    await expect(
      removeWorkspaceCopy(host, ws, 'one', {
        endHolders: [
          { pid: 10, startedAt: 1000 },
          { pid: 11, startedAt: 1999 }
        ]
      })
    ).rejects.toThrow(/Unity\.exe \(pid 11\) still has .* open/)
    expect(host.endedPids).toEqual([])
    expect(server.client('src_wt_one')).toBeDefined()
  })

  it('finds programs that only work in the copy, but not Orca’s own terminals', async () => {
    const folderHolders = new Map<number, string>()
    const host = createFakeCopyHost(server, base, { processes, folderHolders })
    await createWorkspaceCopy(host, ws, { name: 'one' })
    const game = join(copyRoot, 'Game')
    processes.push(
      { pid: 20, name: 'cmd.exe', commandLine: 'cmd.exe', startedAt: 100, parentPid: 1 },
      { pid: 21, name: 'claude.exe', commandLine: 'claude', startedAt: 200, parentPid: 20 },
      { pid: 30, name: 'pwsh.exe', commandLine: 'pwsh.exe', startedAt: 300, ownedByOrca: true }
    )
    folderHolders.set(20, game).set(21, game).set(30, copyRoot)

    const preview = await previewWorkspaceCopyRemoval(host, ws, 'one')
    expect(preview.holders).toEqual([
      {
        pid: 20,
        name: 'cmd.exe',
        commandLine: 'cmd.exe',
        startedAt: 100,
        parentPid: 1,
        heldFolder: game,
        canEnd: true
      },
      {
        pid: 21,
        name: 'claude.exe',
        commandLine: 'claude',
        startedAt: 200,
        parentPid: 20,
        heldFolder: game,
        canEnd: true
      }
    ])
    expect(
      (await processesUnder(host, copyRoot, { includeOrca: true })).map((holder) => holder.pid)
    ).toEqual([20, 21, 30])

    const removed = await removeWorkspaceCopy(
      host,
      ws,
      'one',
      {
        endHolders: [
          { pid: 20, startedAt: 100 },
          { pid: 21, startedAt: 200 }
        ]
      },
      { awaitFolderDeletion: true }
    )
    expect(host.endedPids).toEqual([20, 21])
    expect(removed.folderDeleted).toBe(true)
  })

  it('never ends Explorer or a program it cannot query; the user closes those', async () => {
    const folderHolders = new Map<number, string>()
    const host = createFakeCopyHost(server, base, { processes, folderHolders })
    await createWorkspaceCopy(host, ws, { name: 'one' })
    processes.push(
      { pid: 40, name: 'explorer.exe', commandLine: 'C:\\WINDOWS\\Explorer.EXE', startedAt: 50 },
      // An empty command line: the process refused a query handle, so it cannot be ended either.
      { pid: 50, name: 'MsMpEng.exe', commandLine: '', startedAt: 10 }
    )
    folderHolders.set(40, copyRoot).set(50, join(copyRoot, 'Game'))

    const preview = await previewWorkspaceCopyRemoval(host, ws, 'one')
    expect(preview.holders?.map((holder) => [holder.pid, holder.canEnd])).toEqual([
      [40, false],
      [50, false]
    ])
    await expect(
      removeWorkspaceCopy(host, ws, 'one', {
        endHolders: [
          { pid: 40, startedAt: 50 },
          { pid: 50, startedAt: 10 }
        ]
      })
    ).rejects.toThrow(/Orca will not end them/)
    expect(host.endedPids).toEqual([])
    expect(server.client('src_wt_one')).toBeDefined()
  })

  it('reads the consent from IPC arguments and drops malformed entries', () => {
    expect(
      requireRemovalOptions({
        endHolders: [{ pid: 5, startedAt: 7 }, { pid: -1 }, 'x', { pid: 6 }]
      }).endHolders
    ).toEqual([
      { pid: 5, startedAt: 7 },
      { pid: 6, startedAt: null }
    ])
    expect(requireRemovalOptions({}).endHolders).toBeUndefined()
  })
})
