import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyProfileStateStorage,
  loadProfileState,
  resolveProfileStateFiles
} from './editor-ghost-tab-profile-source.mjs'
import { editorEntityOwner, scanWorkspaceSession } from './editor-ghost-tab-session-scan.mjs'

const WT = 'repo-1::/repo'
const REMOTE = 'env-remote'

function record(filePath, runtimeEnvironmentId) {
  return {
    filePath,
    relativePath: path.basename(filePath),
    worktreeId: WT,
    language: 'ts',
    runtimeEnvironmentId
  }
}

function tab(id, entityId, groupId = 'g1') {
  return { id, entityId, groupId, contentType: 'editor', worktreeId: WT }
}

function ownedId(filePath, runtime) {
  return `editor:${encodeURIComponent(WT)}:${encodeURIComponent(runtime)}:${encodeURIComponent(filePath)}`
}

function session(files, tabs = []) {
  return { openFilesByWorktree: { [WT]: files }, unifiedTabs: { [WT]: tabs } }
}

const reasonsByPath = (scan) =>
  Object.fromEntries((scan.get(WT) ?? []).map((entry) => [entry.filePath, entry.reasons]))

describe('editorEntityOwner', () => {
  it('reads a bare path as unowned and a composite id by its runtime segment', () => {
    expect(editorEntityOwner('/repo/a.ts', '/repo/a.ts')).toBeNull()
    expect(editorEntityOwner(ownedId('/repo/a.ts', REMOTE), '/repo/a.ts')).toBe(REMOTE)
    expect(editorEntityOwner(ownedId('/repo/a.ts', 'local'), '/repo/a.ts')).toBeNull()
  })

  it('says nothing about id shapes that do not encode an owner', () => {
    expect(editorEntityOwner(`${WT}::diff::unstaged::a.ts`, '/repo/a.ts')).toBeUndefined()
    expect(editorEntityOwner('editor-diff:a:b:c:d', '/repo/a.ts')).toBeUndefined()
  })
})

describe('scanWorkspaceSession owner leaks', () => {
  it('flags a remote-owned record whose tab kept the bare-path id', () => {
    const scan = scanWorkspaceSession(
      session([record('/repo/a.ts', REMOTE)], [tab('t1', '/repo/a.ts')])
    )
    expect(reasonsByPath(scan)).toEqual({
      '/repo/a.ts': ['tab-id-owner-mismatch']
    })
    expect(scan.get(WT)[0].tabIdOwners).toEqual([null])
  })

  it('flags a local record behind a remote-owned tab id', () => {
    const scan = scanWorkspaceSession(
      session([record('/repo/a.ts', null)], [tab('t1', ownedId('/repo/a.ts', REMOTE))])
    )
    expect(reasonsByPath(scan)).toEqual({
      '/repo/a.ts': ['tab-id-owner-mismatch']
    })
  })

  it('flags an owned record that disagrees with the rest of its worktree', () => {
    const scan = scanWorkspaceSession(
      session(
        [record('/repo/a.ts', null), record('/repo/b.ts', null), record('/repo/c.ts', REMOTE)],
        [tab('t1', '/repo/a.ts'), tab('t2', '/repo/b.ts'), tab('t3', ownedId('/repo/c.ts', REMOTE))]
      )
    )
    expect(reasonsByPath(scan)).toEqual({
      '/repo/c.ts': ['owner-differs-in-worktree']
    })
  })

  it('keeps the mixed-owner rule for one path, and names the record no tab id owns', () => {
    const scan = scanWorkspaceSession(
      session([record('/repo/a.ts', null), record('/repo/a.ts', REMOTE)], [tab('t1', '/repo/a.ts')])
    )
    expect(reasonsByPath(scan)['/repo/a.ts']).toEqual([
      'duplicate-records',
      'mixed-owners',
      'tab-id-owner-mismatch'
    ])
  })

  it('leaves a consistently owned remote worktree alone', () => {
    const scan = scanWorkspaceSession(
      session(
        [record('/repo/a.ts', REMOTE), record('/repo/b.ts', ` ${REMOTE} `)],
        [tab('t1', ownedId('/repo/a.ts', REMOTE)), tab('t2', ownedId('/repo/b.ts', REMOTE))]
      )
    )
    expect(scan.size).toBe(0)
  })

  it('leaves a local worktree with bare and local-composite ids alone', () => {
    const scan = scanWorkspaceSession(
      session(
        [record('/repo/a.ts', null), record('/repo/b.ts', '')],
        [tab('t1', '/repo/a.ts'), tab('t2', ownedId('/repo/b.ts', 'local'))]
      )
    )
    expect(scan.size).toBe(0)
  })
})

describe('loadProfileState', () => {
  const roots = []
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ghost-tab-source-test-'))
    roots.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of roots.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const profile = {
    settings: { editorAutoSave: true },
    repos: [{ id: 'repo-1', path: '/repo' }],
    workspaceSession: session(
      [record('/repo/a.ts', REMOTE), record('/repo/b.ts', null)],
      [tab('t1', '/repo/a.ts'), tab('t2', '/repo/b.ts')]
    ),
    workspaceSessionsByHostId: {}
  }

  function writeDatabase(databaseFile, state) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databaseFile)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(
      'CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT, domain_version INTEGER, revision INTEGER, updated_at INTEGER, content_hash TEXT)'
    )
    db.exec('CREATE TABLE profile_state_meta (key TEXT PRIMARY KEY, value TEXT)')
    const insert = db.prepare(
      'INSERT INTO profile_state_documents (domain, payload, domain_version, revision, updated_at, content_hash) VALUES (?, ?, 1, 1, 0, ?)'
    )
    for (const [domain, value] of Object.entries(state)) {
      insert.run(domain, JSON.stringify(value), 'hash')
    }
    return db
  }

  it('reads a migrated profile from the database and matches the JSON scan', () => {
    const jsonDir = tempDir()
    writeFileSync(path.join(jsonDir, 'orca-data.json'), JSON.stringify(profile))
    const sqliteDir = tempDir()
    // Left open so committed rows stay in the WAL, as with a running app.
    const db = writeDatabase(path.join(sqliteDir, 'profile-state.db'), profile)
    try {
      const fromJson = loadProfileState(jsonDir)
      const fromDb = loadProfileState(sqliteDir)
      expect(fromJson.classification).toBe('json-only')
      expect(fromDb.classification).toBe('sqlite-only')
      expect(fromDb.state).toEqual(fromJson.state)
      const scan = scanWorkspaceSession(fromDb.state.workspaceSession)
      expect(scan).toEqual(scanWorkspaceSession(fromJson.state.workspaceSession))
      expect(scan.size).toBe(1)
    } finally {
      db.close()
    }
  })

  it('prefers the database over a stale orca-data.json and warns', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'orca-data.json'), JSON.stringify({ workspaceSession: {} }))
    writeDatabase(path.join(dir, 'profile-state.db'), profile).close()
    for (const dataArg of [dir, path.join(dir, 'orca-data.json')]) {
      const loaded = loadProfileState(dataArg)
      expect(loaded.classification).toBe('both')
      expect(loaded.state).toEqual(profile)
      expect(loaded.warnings).toHaveLength(1)
    }
  })

  it('treats an exported JSON outside a profile dir as standalone', () => {
    const dir = tempDir()
    const exported = path.join(dir, 'export.json')
    writeFileSync(exported, JSON.stringify(profile))
    writeDatabase(path.join(dir, 'profile-state.db'), {
      workspaceSession: {}
    }).close()
    expect(resolveProfileStateFiles(exported).databaseFile).toBeNull()
    expect(loadProfileState(exported)).toMatchObject({
      classification: 'json-only',
      state: profile
    })
  })

  it('counts a lone journal file as a database and names both files when nothing exists', () => {
    const dir = tempDir()
    mkdirSync(path.join(dir, 'empty'))
    writeFileSync(path.join(dir, 'profile-state.db-wal'), '')
    expect(
      classifyProfileStateStorage(
        path.join(dir, 'orca-data.json'),
        path.join(dir, 'profile-state.db')
      )
    ).toBe('sqlite-only')
    expect(() => loadProfileState(path.join(dir, 'empty'))).toThrow(
      /orca-data\.json and .*profile-state\.db/
    )
  })
})
