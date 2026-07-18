import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  E2E_TEST_REPO_PATH_ENV,
  E2E_TEST_WORKTREE_PATH_ENV,
  cleanupE2ERunScope,
  prepareE2ERunScope,
  readPreparedE2ERunResources,
  resolveE2ERunScope,
  writeE2ERunManifest
} from './e2e-run-scope'

const testRoots: string[] = []

function createTestRoot(): string {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-run-scope-test-'))
  testRoots.push(testRoot)
  return testRoot
}

afterEach(() => {
  for (const testRoot of testRoots.splice(0)) {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

describe('Electron E2E run scope', () => {
  it('uses inherited run IDs to isolate control files', () => {
    const testRoot = createTestRoot()
    const first = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-a' }
    })
    const inherited = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-a' }
    })
    const second = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-b' }
    })

    expect(inherited).toEqual(first)
    expect(second.repoPathFile).not.toBe(first.repoPathFile)
    expect(second.manifestFile).not.toBe(first.manifestFile)
  })

  it('publishes exact owned resource paths before the child process starts', () => {
    const testRoot = createTestRoot()
    const env: Record<string, string | undefined> = { ORCA_E2E_RUN_ID: 'run-a' }

    const prepared = prepareE2ERunScope({ tempDir: testRoot, env })
    const inherited = readPreparedE2ERunResources(prepared.scope, env)
    const manifest = JSON.parse(readFileSync(prepared.scope.manifestFile, 'utf8')) as {
      resources: string[]
    }

    expect(env[E2E_TEST_REPO_PATH_ENV]).toBe(prepared.testRepoDir)
    expect(env[E2E_TEST_WORKTREE_PATH_ENV]).toBe(prepared.worktreeDir)
    expect(inherited).toEqual({
      testRepoDir: prepared.testRepoDir,
      worktreeDir: prepared.worktreeDir
    })
    expect(new Set(manifest.resources)).toEqual(
      new Set([prepared.testRepoDir, prepared.worktreeDir])
    )
    expect(existsSync(prepared.testRepoDir)).toBe(true)
    expect(existsSync(prepared.worktreeDir)).toBe(false)

    cleanupE2ERunScope(prepared.scope)
    expect(existsSync(prepared.testRepoDir)).toBe(false)
    expect(existsSync(prepared.scope.manifestFile)).toBe(false)
  })

  it('removes only the exact resources registered by its own run', () => {
    const testRoot = createTestRoot()
    const first = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-a' }
    })
    const second = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-b' }
    })
    const firstRepo = path.join(testRoot, 'orca-e2e-repo-a')
    const firstWorktree = path.join(testRoot, 'orca-e2e-worktree-a')
    const secondRepo = path.join(testRoot, 'orca-e2e-repo-b')

    for (const resourcePath of [firstRepo, firstWorktree, secondRepo]) {
      mkdirSync(resourcePath)
    }
    writeE2ERunManifest(first, [firstWorktree, firstRepo])
    writeE2ERunManifest(second, [secondRepo])
    writeFileSync(first.repoPathFile, firstRepo)
    writeFileSync(second.repoPathFile, secondRepo)

    cleanupE2ERunScope(first)

    expect(existsSync(firstRepo)).toBe(false)
    expect(existsSync(firstWorktree)).toBe(false)
    expect(existsSync(first.repoPathFile)).toBe(false)
    expect(existsSync(first.manifestFile)).toBe(false)
    expect(existsSync(secondRepo)).toBe(true)
    expect(existsSync(second.repoPathFile)).toBe(true)
    expect(existsSync(second.manifestFile)).toBe(true)
  })

  it('rejects cleanup paths outside the scoped temp directory', () => {
    const testRoot = createTestRoot()
    const scope = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-a' }
    })

    expect(() => writeE2ERunManifest(scope, [path.dirname(testRoot)])).toThrow(
      /outside the E2E temp directory/
    )
  })

  it('validates the recorded temp root before deleting any resource', () => {
    const testRoot = createTestRoot()
    const scope = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-a' }
    })
    const repoPath = path.join(testRoot, 'orca-e2e-repo-a')
    mkdirSync(repoPath)
    writeE2ERunManifest(scope, [repoPath])
    const manifest = JSON.parse(readFileSync(scope.manifestFile, 'utf8')) as Record<string, unknown>
    manifest.tempDir = path.dirname(testRoot)
    writeFileSync(scope.manifestFile, `${JSON.stringify(manifest)}\n`)

    expect(() => cleanupE2ERunScope(scope)).toThrow(/temp directory mismatch/)
    expect(existsSync(repoPath)).toBe(true)
  })

  it('does not let a second writer replace the first run manifest', () => {
    const testRoot = createTestRoot()
    const scope = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-a' }
    })
    const firstRepo = path.join(testRoot, 'orca-e2e-repo-first')
    const secondRepo = path.join(testRoot, 'orca-e2e-repo-second')
    mkdirSync(firstRepo)
    mkdirSync(secondRepo)
    writeE2ERunManifest(scope, [firstRepo])

    expect(() => writeE2ERunManifest(scope, [secondRepo])).toThrow(/already exists/)
    cleanupE2ERunScope(scope)
    expect(existsSync(firstRepo)).toBe(false)
    expect(existsSync(secondRepo)).toBe(true)
  })

  it('does not trust a repo pointer when no manifest exists', () => {
    const testRoot = createTestRoot()
    const scope = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-a' }
    })
    const unrelatedPath = path.join(testRoot, 'unrelated-user-data')
    mkdirSync(unrelatedPath)
    writeFileSync(scope.repoPathFile, unrelatedPath)

    cleanupE2ERunScope(scope, { allowMissingManifest: true })

    expect(existsSync(scope.repoPathFile)).toBe(false)
    expect(existsSync(unrelatedPath)).toBe(true)
  })

  it('rejects a symlink that escapes the scoped temp root', () => {
    const testRoot = createTestRoot()
    const outsideRoot = createTestRoot()
    const scope = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-a' }
    })
    const linkedRepo = path.join(testRoot, 'orca-e2e-repo-linked')
    symlinkSync(outsideRoot, linkedRepo, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => writeE2ERunManifest(scope, [linkedRepo])).toThrow(/symbolic link/)
    expect(existsSync(outsideRoot)).toBe(true)
  })

  it('rejects an in-root symlink instead of deleting another run resource', () => {
    const testRoot = createTestRoot()
    const scope = resolveE2ERunScope({
      tempDir: testRoot,
      env: { ORCA_E2E_RUN_ID: 'run-a' }
    })
    const otherRunRepo = path.join(testRoot, 'orca-e2e-repo-other-run')
    const linkedRepo = path.join(testRoot, 'orca-e2e-repo-linked')
    mkdirSync(otherRunRepo)
    symlinkSync(otherRunRepo, linkedRepo, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => writeE2ERunManifest(scope, [linkedRepo])).toThrow(/symbolic link/)
    expect(existsSync(otherRunRepo)).toBe(true)
  })

  it('rejects unsafe run IDs before creating control paths', () => {
    const testRoot = createTestRoot()

    expect(() =>
      resolveE2ERunScope({
        tempDir: testRoot,
        env: { ORCA_E2E_RUN_ID: '../other-run' }
      })
    ).toThrow(/ORCA_E2E_RUN_ID/)
  })
})
