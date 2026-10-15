import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeCopyHost } from './__fixtures__/fake-copy-host'
import { FakePerforceServer } from './__fixtures__/fake-perforce-server'
import { createWorkspaceCopy } from './workspace-copy-create'
import { removeWorkspaceCopy } from './workspace-copy-remove'
import { resetWorkspaceScansForTests, scanWorkspace } from '../perforce-workspace-scan'

let base: string
let ws: string
let server: FakePerforceServer

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'p4copy-lock-'))
  ws = join(base, 'ws')
  server = new FakePerforceServer()
  server.addStream('//s/main', { 'a.txt': 1 })
  server.addSyncedClient('src', ws, '//s/main')
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'p4config.txt'), 'P4PORT=srv:1666\nP4CLIENT=src\n')
})

afterEach(async () => {
  resetWorkspaceScansForTests()
  await rm(base, { recursive: true, force: true })
})

// Windows will not move a folder while a file in it is open, as it is for a moment after Orca stops
// the copy's terminals and agent sessions.
describe.runIf(process.platform === 'win32')('removeWorkspaceCopy with the copy held open', () => {
  it('waits for a just-stopped program to let go of the copy', async () => {
    const host = createFakeCopyHost(server, base)
    await createWorkspaceCopy(host, ws, { name: 'one' })
    const held = await open(join(base, 'ws.wt', 'one', 'a.txt'), 'r')
    const release = setTimeout(() => void held.close(), 500)
    try {
      const removed = await removeWorkspaceCopy(host, ws, 'one', {}, { awaitFolderDeletion: true })
      expect(removed).toMatchObject({ clientDeleted: true, folderDeleted: true })
      expect(existsSync(join(base, 'ws.wt', 'one'))).toBe(false)
    } finally {
      clearTimeout(release)
      await held.close().catch(() => {})
    }
  })

  it('stops a Source Control scan running in the copy', async () => {
    const host = createFakeCopyHost(server, base)
    await createWorkspaceCopy(host, ws, { name: 'one' })
    const copyRoot = join(base, 'ws.wt', 'one')
    const held = await open(join(copyRoot, 'a.txt'), 'r')
    const scan = scanWorkspace(
      copyRoot,
      15_000,
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            void held.close().then(() => resolve({ code: null, stdout: '', stderr: 'aborted' }))
          })
        })
    )
    const started = Date.now()
    const removed = await removeWorkspaceCopy(host, ws, 'one', {}, { awaitFolderDeletion: true })
    expect(removed.folderDeleted).toBe(true)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect((await scan).stderr).toBe('aborted')
  })

  it('refuses without touching Perforce while the copy stays held', async () => {
    const host = createFakeCopyHost(server, base)
    await createWorkspaceCopy(host, ws, { name: 'one' })
    const held = await open(join(base, 'ws.wt', 'one', 'a.txt'), 'r')
    try {
      await expect(removeWorkspaceCopy(host, ws, 'one')).rejects.toThrow(/Nothing was changed/)
      expect(server.client('src_wt_one')).toBeDefined()
      expect(existsSync(join(base, 'ws.wt', 'one', 'a.txt'))).toBe(true)
    } finally {
      await held.close()
    }
  }, 20_000)
})
