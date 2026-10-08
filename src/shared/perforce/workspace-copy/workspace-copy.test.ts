import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeCopyHost } from './__fixtures__/fake-copy-host'
import { depotContent, FakePerforceServer } from './__fixtures__/fake-perforce-server'
import { createWorkspaceCopy } from './workspace-copy-create'
import { listWorkspaceCopies } from './workspace-copy-list'
import { previewWorkspaceCopyRemoval } from './workspace-copy-removal-preview'
import { removeWorkspaceCopy } from './workspace-copy-remove'
import { resetBlockCloningProbeCacheForTests } from './workspace-copy-readiness'

const STREAM = '//s/main'
const FILES = {
  'a.txt': 3,
  'sub/b.txt': 1,
  'Game/Assets/x.cs': 2,
  'Game/ProjectSettings/ProjectVersion.txt': 1,
  'Game/Temp/tracked.txt': 1
}

let base: string
let ws: string
let server: FakePerforceServer

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'p4copy-'))
  ws = join(base, 'ws')
  server = new FakePerforceServer()
  server.addStream(STREAM, FILES)
  server.addSyncedClient('src', ws, STREAM)
  await put(join(ws, 'p4config.txt'), 'P4PORT=srv:1666\nP4CLIENT=src\n')
  await put(join(ws, 'Game', 'Library', 'ArtifactDB-lock'), 'lock')
  await put(join(ws, 'Game', 'Library', 'big.asset'), 'imported')
  await put(join(ws, 'Game', 'Temp', 'scratch.tmp'), 'editor temp')
  await put(
    join(ws, 'Game', 'UserSettings', 'EditorUserSettings.asset'),
    'EditorUserSettings:\n  m_ConfigSettings:\n    vcPerforceWorkspace:\n      value: 1a2b\n      flags: 0\n    vcPerforceServer:\n      value: 3c\n'
  )
  await put(
    join(ws, 'Game', 'ProjectSettings', 'VersionControlSettings.asset'),
    'VersionControlSettings:\n  m_Mode: Perforce\n'
  )
  await put(
    join(ws, '.idea', '.idea.Game', '.idea', 'workspace.xml'),
    `<option name="client" value="src" /><option name="root" value="${ws}" />`
  )
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('createWorkspaceCopy (same stream)', () => {
  it('copies the workspace, gives it its own client and adopts the have-list without downloading', async () => {
    const source = server.client('src')
    source?.opened.set('a.txt', { rel: 'a.txt', action: 'edit' })
    source?.opened.set('new.txt', { rel: 'new.txt', action: 'add' })
    await writeFile(join(ws, 'a.txt'), 'my unsubmitted edit')
    await writeFile(join(ws, 'new.txt'), 'brand new')
    const host = createFakeCopyHost(server, base)
    const phases: string[] = []

    const result = await createWorkspaceCopy(
      host,
      ws,
      { name: 'one', stream: { kind: 'same-stream' } },
      (p) => phases.push(p.phase)
    )

    const copyRoot = join(base, 'ws.wt', 'one')
    expect(result.copyRoot).toBe(copyRoot)
    expect(result.client).toBe('src_wt_one')
    expect(result.mode).toBe('same-stream')
    expect(server.client('src_wt_one')).toMatchObject({
      root: copyRoot,
      stream: STREAM
    })
    expect(server.haveOf('src_wt_one')).toEqual(server.haveOf('src'))
    // Open files go back to the depot version; adds are not carried over.
    expect(await readFile(join(copyRoot, 'a.txt'), 'utf8')).toBe(depotContent('a.txt', 3))
    expect(existsSync(join(copyRoot, 'new.txt'))).toBe(false)
    expect(await readFile(join(ws, 'a.txt'), 'utf8')).toBe('my unsubmitted edit')
    // Editor runtime state stays behind; tracked files under it come back from the depot.
    expect(existsSync(join(copyRoot, 'Game', 'Library', 'ArtifactDB-lock'))).toBe(false)
    expect(existsSync(join(copyRoot, 'Game', 'Library', 'big.asset'))).toBe(true)
    expect(existsSync(join(copyRoot, 'Game', 'Temp', 'scratch.tmp'))).toBe(false)
    expect(existsSync(join(copyRoot, 'Game', 'Temp', 'tracked.txt'))).toBe(true)
    expect(result.trackedInSkippedFolders).toBe(1)
    // The copy names its own client; the source is untouched.
    expect(await readFile(join(copyRoot, 'p4config.txt'), 'utf8')).toBe(
      'P4PORT=srv:1666\nP4CLIENT=src_wt_one\n'
    )
    expect(await readFile(join(ws, 'p4config.txt'), 'utf8')).toContain('P4CLIENT=src\n')
    const unity = await readFile(
      join(copyRoot, 'Game', 'UserSettings', 'EditorUserSettings.asset'),
      'utf8'
    )
    expect(unity).not.toContain('vcPerforceWorkspace')
    expect(unity).toContain('vcPerforceServer')
    const rider = await readFile(
      join(copyRoot, '.idea', '.idea.Game', '.idea', 'workspace.xml'),
      'utf8'
    )
    expect(rider).toBe(
      `<option name="client" value="src_wt_one" /><option name="root" value="${copyRoot}" />`
    )
    expect(result.unityProjects).toEqual(['Game'])
    expect(result.unityVersionControlBinding).toContain('"src_wt_one"')
    expect(result.openFilesRestored).toBe(1)
    expect(result.addsRemoved).toBe(1)
    const marker = JSON.parse(await readFile(join(base, 'ws.wt', 'one.p4-worktree.json'), 'utf8'))
    expect(marker).toMatchObject({
      schema: 1,
      client: 'src_wt_one',
      createdBy: 'orca'
    })
    // Only what Orca and an agent in the copy use; nothing a particular outside script needs.
    expect(Object.keys(marker).sort()).toEqual([
      'client',
      'copyRoot',
      'created',
      'createdBy',
      'handBack',
      'mode',
      'name',
      'schema',
      'source',
      'stream',
      'unityVersionControlBinding',
      'updated'
    ])
    expect(phases).toContain('copying')
    expect(phases).not.toContain('rolling-back')
    // The flush adopts the source's have-list: nothing is synced from the depot.
    expect(server.calls).toContainEqual(['-q', '-c', 'src_wt_one', 'flush', '//src_wt_one/...@src'])
  })

  it('rolls back the client and folder when a step fails', async () => {
    const host = createFakeCopyHost(server, base)
    server.failWhen = (args) => args.includes('flush')

    await expect(createWorkspaceCopy(host, ws, { name: 'two' })).rejects.toThrow(
      /Everything it created was removed/
    )

    expect(server.client('src_wt_two')).toBeUndefined()
    expect(existsSync(join(base, 'ws.wt', 'two'))).toBe(false)
    expect(existsSync(join(base, 'ws.wt', 'two.p4-worktree.json'))).toBe(false)
  })

  it('refuses a name that is taken, before changing anything', async () => {
    const host = createFakeCopyHost(server, base)
    await createWorkspaceCopy(host, ws, { name: 'one' })
    const calls = host.robocopyCalls.length

    await expect(createWorkspaceCopy(host, ws, { name: 'one' })).rejects.toThrow(/already exists/)
    expect(host.robocopyCalls.length).toBe(calls)
  })

  it('refuses when the client does not come from a P4CONFIG file', async () => {
    await rm(join(ws, 'p4config.txt'))
    const host = createFakeCopyHost(server, base)

    await expect(createWorkspaceCopy(host, ws, { name: 'one' })).rejects.toThrow(/P4CONFIG/)
    expect(existsSync(join(base, 'ws.wt', 'one'))).toBe(false)
  })

  it('refuses a drive that does not block-clone', async () => {
    resetBlockCloningProbeCacheForTests()
    const host = createFakeCopyHost(server, base, { blockClones: false })

    await expect(createWorkspaceCopy(host, ws, { name: 'one' })).rejects.toThrow(
      /does not block-clone/
    )
    expect(server.client('src_wt_one')).toBeUndefined()
    resetBlockCloningProbeCacheForTests()
  })
})

describe('createWorkspaceCopy (other streams)', () => {
  it('puts each copy on a stream of its own under the workspace stream by default', async () => {
    const host = createFakeCopyHost(server, base)
    server.addStream(STREAM, { ...FILES, 'a.txt': 4 })

    const result = await createWorkspaceCopy(host, ws, { name: 'kid' })

    expect(result).toMatchObject({ mode: 'child', stream: `${STREAM}_wt_kid` })
    expect(server.streams.has(`${STREAM}_wt_kid`)).toBe(true)
    expect(server.client('src_wt_kid')?.stream).toBe(`${STREAM}_wt_kid`)
    // Branched at the parent's latest change: the file submitted since the source synced is fetched.
    expect(await readFile(join(base, 'ws.wt', 'kid', 'a.txt'), 'utf8')).toBe(
      depotContent('a.txt', 4)
    )
    expect(server.calls).toContainEqual(['-q', '-c', 'src_wt_kid', 'flush', '//src_wt_kid/...'])
  })

  it('branches from another parent stream when asked', async () => {
    server.addStream('//s/dev', { ...FILES, 'dev-only.txt': 1 }, STREAM)
    const host = createFakeCopyHost(server, base)

    const result = await createWorkspaceCopy(host, ws, {
      name: 'feat',
      stream: { kind: 'child', parent: '//s/dev' }
    })

    expect(result).toMatchObject({ mode: 'child', stream: '//s/dev_wt_feat' })
    expect(existsSync(join(base, 'ws.wt', 'feat', 'dev-only.txt'))).toBe(true)
  })

  it('fetches only the files that differ when the copy goes on another stream', async () => {
    server.addStream('//s/dev', { ...FILES, 'a.txt': 7, 'dev-only.txt': 1 }, STREAM)
    const host = createFakeCopyHost(server, base)

    const result = await createWorkspaceCopy(host, ws, {
      name: 'dev',
      stream: { kind: 'stream', stream: '//s/dev' }
    })

    const copyRoot = join(base, 'ws.wt', 'dev')
    expect(result.mode).toBe('other-stream')
    expect(result.alignedFiles).toBe(2)
    expect(await readFile(join(copyRoot, 'a.txt'), 'utf8')).toBe(depotContent('a.txt', 7))
    expect(await readFile(join(copyRoot, 'dev-only.txt'), 'utf8')).toBe(
      depotContent('dev-only.txt', 1)
    )
  })
})

describe('listWorkspaceCopies', () => {
  it('joins markers on disk with the server clients and flags leftovers', async () => {
    const host = createFakeCopyHost(server, base)
    await createWorkspaceCopy(host, ws, { name: 'one' })
    server.addSyncedClient('src_wt_ghost', join(base, 'ws.wt', 'ghost'), STREAM)
    await rm(join(base, 'ws.wt', 'ghost'), { recursive: true })

    const listed = await listWorkspaceCopies(host, ws)

    expect(listed.serverChecked).toBe(true)
    expect(
      listed.copies.map((c) => [c.name, c.clientExists, c.folderExists, c.markerExists])
    ).toEqual([
      ['ghost', true, false, false],
      ['one', true, true, true]
    ])
  })
})

describe('removeWorkspaceCopy', () => {
  it('previews what will happen and refuses open files until the user opts in', async () => {
    const host = createFakeCopyHost(server, base)
    await createWorkspaceCopy(host, ws, { name: 'one' })
    server.client('src_wt_one')?.opened.set('a.txt', { rel: 'a.txt', action: 'edit' })
    server.addPending('src_wt_one', 'work in progress')

    const preview = await previewWorkspaceCopyRemoval(host, ws, 'one')
    expect(preview).toMatchObject({
      client: 'src_wt_one',
      clientExists: true,
      folderExists: true,
      openFiles: { count: 1, sample: ['a.txt'] },
      blockers: { openFiles: true, shelves: false }
    })
    expect(preview.pendingChanges).toEqual([
      expect.objectContaining({
        description: 'work in progress',
        shelvedFiles: 0
      })
    ])

    await expect(removeWorkspaceCopy(host, ws, 'one')).rejects.toThrow(/1 file\(s\) are open/)
    expect(server.client('src_wt_one')).toBeDefined()
    expect(existsSync(join(base, 'ws.wt', 'one'))).toBe(true)

    const removed = await removeWorkspaceCopy(
      host,
      ws,
      'one',
      { revertOpenFiles: true },
      { awaitFolderDeletion: true }
    )
    expect(removed).toMatchObject({
      clientDeleted: true,
      folderDeleted: true,
      revertedFiles: 1
    })
    expect(server.client('src_wt_one')).toBeUndefined()
    expect(existsSync(join(base, 'ws.wt', 'one'))).toBe(false)
    expect(existsSync(join(base, 'ws.wt', 'one.p4-worktree.json'))).toBe(false)
    expect(existsSync(join(ws, 'a.txt'))).toBe(true)
  })

  it('refuses shelves until the user chooses to delete them', async () => {
    const host = createFakeCopyHost(server, base)
    await createWorkspaceCopy(host, ws, { name: 'one' })
    const change = server.addPending('src_wt_one', 'shelved work', 2)

    await expect(removeWorkspaceCopy(host, ws, 'one')).rejects.toThrow(
      new RegExp(`${change}.*shelved`)
    )

    const removed = await removeWorkspaceCopy(
      host,
      ws,
      'one',
      { deleteShelves: true },
      { awaitFolderDeletion: true }
    )
    expect(removed.deletedShelves).toEqual([change])
    expect(server.client('src_wt_one')).toBeUndefined()
  })

  it('deletes an unused child stream and keeps one with submitted work', async () => {
    const host = createFakeCopyHost(server, base)
    await createWorkspaceCopy(host, ws, {
      name: 'kid',
      stream: { kind: 'child' }
    })
    await createWorkspaceCopy(host, ws, {
      name: 'kept',
      stream: { kind: 'child' }
    })
    const kept = server.streams.get(`${STREAM}_wt_kept`.toLowerCase())
    if (kept) {
      kept.submits = 1
    }

    expect(
      (await removeWorkspaceCopy(host, ws, 'kid', {}, { awaitFolderDeletion: true })).streamDeleted
    ).toBe(true)
    const keptResult = await removeWorkspaceCopy(
      host,
      ws,
      'kept',
      {},
      { awaitFolderDeletion: true }
    )
    expect(keptResult.streamDeleted).toBe(false)
    expect(keptResult.note).toContain(`p4 copy -S ${STREAM}_wt_kept`)
  })

  it('deletes a child stream whose only work was a shelf the removal deletes', async () => {
    const host = createFakeCopyHost(server, base)
    await createWorkspaceCopy(host, ws, { name: 'shelf', stream: { kind: 'child' } })
    server.addPending('src_wt_shelf', 'wip', 1)
    const removed = await removeWorkspaceCopy(
      host,
      ws,
      'shelf',
      { deleteShelves: true },
      { awaitFolderDeletion: true }
    )
    expect(removed.streamDeleted).toBe(true)
  })

  it('refuses to delete a folder the client does not root at the expected copy path', async () => {
    const host = createFakeCopyHost(server, base)
    server.addSyncedClient('src_wt_odd', join(base, 'elsewhere'), STREAM)

    await expect(previewWorkspaceCopyRemoval(host, ws, 'odd')).rejects.toThrow(
      /Orca only deletes folders/
    )
    expect(existsSync(join(base, 'elsewhere', 'a.txt'))).toBe(true)
  })
})
