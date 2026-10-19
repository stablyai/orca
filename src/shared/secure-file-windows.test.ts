import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, runProcessSync } from '@orca/process-host'
import {
  __getSecureFileHardeningCacheStateForTests,
  __resetSecureFileHardenedPathsForTests,
  hardenExistingSecureFile,
  writeSecureFile
} from './secure-file'
import { mayAttemptHardening } from './secure-path-hardening-retry-budget'
import {
  setSecurePathHardeningReporter,
  type SecurePathHardeningReport
} from './secure-path-hardening-report'
import {
  loadWindowsSecurity,
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from './windows-security-addon'
import {
  createFakeWindowsSecurity,
  FAKE_USER_SID,
  type FakeWindowsSecurity
} from './windows-security-addon.test-fixture'

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

const FILE_SDDL = `D:P(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;;FA;;;${FAKE_USER_SID})`
const DIRECTORY_SDDL = `D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)(A;OICI;FA;;;${FAKE_USER_SID})`
/** What the icacls-era hardening left on disk; it must keep verifying with no rewrite. */
const ICACLS_ERA_FILE_SDDL = `D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${FAKE_USER_SID})`
const ICACLS_ERA_DIRECTORY_SDDL = `D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;${FAKE_USER_SID})`

describe('Windows secure files through the native ACL addon', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const tempDirs: string[] = []
  let fake: FakeWindowsSecurity
  let reports: SecurePathHardeningReport[]

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resetWindowsSecurityLoadForTests()
    __resetSecureFileHardenedPathsForTests()
    fake = createFakeWindowsSecurity()
    setWindowsSecurityForTests(fake)
    reports = []
    setSecurePathHardeningReporter((entry) => reports.push(entry))
    vi.mocked(runProcess).mockReset()
    vi.mocked(runProcessSync).mockReset()
  })

  afterEach(() => {
    // The whole point of #25583 and #26027: no ACL work may start a process.
    expect(runProcess).not.toHaveBeenCalled()
    expect(runProcessSync).not.toHaveBeenCalled()
    setSecurePathHardeningReporter(null)
    setWindowsSecurityForTests(null)
    resetWindowsSecurityLoadForTests()
    __resetSecureFileHardenedPathsForTests()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-secure-file-win-'))
    tempDirs.push(dir)
    return dir
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  describe('write path', () => {
    it('creates the credential already restricted and publishes it without touching its ACL', () => {
      const dir = tempDir()
      const targetPath = join(dir, 'secret.json')

      expect(writeSecureFile(targetPath, 'contents')).toBe(true)

      const [create] = fake.callsFor('create')
      expect(create?.path).toMatch(/secret\.json\.\d+\.\d+\.[0-9a-f]+\.tmp$/)
      expect(create && 'sddl' in create ? create.sddl : '').toBe(FILE_SDDL)
      expect(readFileSync(targetPath, 'utf-8')).toBe('contents')
      // Born restricted: no ACL is ever set on the temp file or the published one.
      expect(fake.callsFor('set')).toEqual([])
      expect(fake.calls.some((call) => call.path === targetPath)).toBe(false)
    })

    it('reports false but still writes when the addon cannot load, and says so once', () => {
      setWindowsSecurityForTests(null)
      const dir = tempDir()

      for (const name of ['a.json', 'b.json', 'c.json']) {
        expect(writeSecureFile(join(dir, name), name)).toBe(false)
        expect(readFileSync(join(dir, name), 'utf-8')).toBe(name)
      }
      expect(reports.filter((entry) => entry.stage === 'addon')).toHaveLength(1)
    })

    // Never a truncating plain write of the secret: a failed create surfaces like any fs failure.
    it('throws a failed restricted create and leaves no temp file', () => {
      const dir = tempDir()
      const targetPath = join(dir, 'secret.json')
      writeFileSync(targetPath, 'previous')
      fake.createFileWithDacl = () => {
        throw new Error('CreateFileW failed with Win32 error 5')
      }

      expect(() => writeSecureFile(targetPath, 'contents')).toThrow(
        'CreateFileW failed with Win32 error 5'
      )

      expect(readFileSync(targetPath, 'utf-8')).toBe('previous')
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    })

    it('reports false when the filesystem drops the descriptor (FAT32, some shares)', () => {
      const dir = tempDir()
      const targetPath = join(dir, 'secret.json')
      const realCreate = fake.createFileWithDacl
      fake.createFileWithDacl = (path, sddl, data) => {
        realCreate(path, sddl, data)
        const created = fake.callsFor('create').at(-1)?.path ?? path
        fake.dacls.set(created, 'D:NO_ACCESS_CONTROL')
      }

      expect(writeSecureFile(targetPath, 'contents')).toBe(false)

      expect(reports).toContainEqual(
        expect.objectContaining({ stage: 'verify', detail: expect.stringContaining('NULL DACL') })
      )
    })

    it('clears the read-path backoff once a write restricts the same path', () => {
      const dir = tempDir()
      const targetPath = join(dir, 'secret.json')
      writeFileSync(targetPath, '{}')
      fake.failing.add(targetPath)
      let clock = performance.now()
      const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
      for (const wait of [0, 61_000, 121_000]) {
        clock += wait
        hardenExistingSecureFile(targetPath)
      }
      expect(mayAttemptHardening(targetPath)).toBe(false)

      fake.failing.delete(targetPath)
      expect(writeSecureFile(targetPath, 'contents')).toBe(true)

      expect(mayAttemptHardening(targetPath)).toBe(true)
      expect(reports).toContainEqual(expect.objectContaining({ targetPath, stage: 'recovered' }))
      now.mockRestore()
    })
  })

  describe('directory relock', () => {
    it('relocks the parent once, on the thread pool, across many writes', async () => {
      const dir = tempDir()
      for (let i = 0; i < 5; i++) {
        writeSecureFile(join(dir, `secret-${i}.json`), `contents-${i}`)
      }
      await settle()

      expect(fake.callsFor('setAsync', dir)).toEqual([
        expect.objectContaining({ op: 'setAsync', path: dir, sddl: DIRECTORY_SDDL })
      ])
      expect(fake.callsFor('set', dir)).toEqual([])
    })

    it('never rewrites a directory the icacls-era hardening already locked', async () => {
      const dir = tempDir()
      fake.dacls.set(dir, ICACLS_ERA_DIRECTORY_SDDL)

      writeSecureFile(join(dir, 'secret.json'), 'contents')
      await settle()

      expect(fake.callsFor('setAsync')).toEqual([])
    })

    // A relock walks every descendant: ~2 s on a 29k-entry userData. Writes must not wait on it.
    it('neither blocks a write nor starts twice while a slow relock is still running', async () => {
      fake.holdAsync = true
      const dir = tempDir()

      for (let i = 0; i < 3; i++) {
        expect(writeSecureFile(join(dir, `secret-${i}.json`), 'contents')).toBe(true)
        expect(readFileSync(join(dir, `secret-${i}.json`), 'utf-8')).toBe('contents')
      }
      await settle()
      expect(fake.callsFor('setAsync', dir)).toHaveLength(1)

      fake.releaseAsync()
      await settle()
      writeSecureFile(join(dir, 'later.json'), 'contents')
      await settle()
      expect(fake.callsFor('setAsync', dir)).toHaveLength(1)
      expect(fake.dacls.get(dir)).toBe(DIRECTORY_SDDL)
    })

    it('retries a failed relock only after its backoff, not on every write', async () => {
      const dir = tempDir()
      fake.failing.add(dir)
      let clock = performance.now()
      const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)

      writeSecureFile(join(dir, 'a.json'), 'a')
      await settle()
      writeSecureFile(join(dir, 'b.json'), 'b')
      await settle()
      expect(fake.callsFor('setAsync', dir)).toHaveLength(1)

      clock += 61_000
      fake.failing.delete(dir)
      writeSecureFile(join(dir, 'c.json'), 'c')
      await settle()
      expect(fake.callsFor('setAsync', dir)).toHaveLength(2)
      expect(reports).toContainEqual(expect.objectContaining({ targetPath: dir, stage: 'apply' }))
      now.mockRestore()
    })
  })

  describe('read path', () => {
    function existingFile(): { dir: string; targetPath: string } {
      const dir = tempDir()
      const targetPath = join(dir, 'secret.json')
      writeFileSync(targetPath, '{}')
      return { dir, targetPath }
    }

    it('fixes an inherited-ACL file in-process, synchronously, once while it is unchanged', () => {
      const { targetPath } = existingFile()

      for (let i = 0; i < 3; i++) {
        hardenExistingSecureFile(targetPath)
      }

      expect(fake.callsFor('set', targetPath)).toEqual([
        expect.objectContaining({ op: 'set', path: targetPath, sddl: FILE_SDDL })
      ])
      expect(fake.callsFor('setAsync', targetPath)).toEqual([])
    })

    it('leaves a file the icacls-era hardening locked exactly as it is', () => {
      const { targetPath } = existingFile()
      fake.dacls.set(targetPath, ICACLS_ERA_FILE_SDDL)

      hardenExistingSecureFile(targetPath)

      expect(fake.callsFor('set', targetPath)).toEqual([])
      expect(fake.dacls.get(targetPath)).toBe(ICACLS_ERA_FILE_SDDL)
    })

    it('rewrites a protected DACL that grants a stranger', () => {
      const { targetPath } = existingFile()
      fake.dacls.set(targetPath, 'D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;WD)')

      hardenExistingSecureFile(targetPath)

      expect(fake.dacls.get(targetPath)).toBe(FILE_SDDL)
    })

    it('re-checks a file whose metadata changed after it was cached', async () => {
      const { targetPath } = existingFile()
      hardenExistingSecureFile(targetPath)
      hardenExistingSecureFile(targetPath)
      const checksWhileUnchanged = fake.callsFor('get', targetPath).length
      await new Promise((resolve) => setTimeout(resolve, 20))
      writeFileSync(targetPath, '{"changed":true}')

      hardenExistingSecureFile(targetPath)

      expect(fake.callsFor('get', targetPath)).toHaveLength(checksWhileUnchanged + 1)
    })

    it('does not re-verify the parent directory as its mtime churns', async () => {
      const { dir, targetPath } = existingFile()
      hardenExistingSecureFile(targetPath)
      await settle()
      writeFileSync(join(dir, 'other.json'), '{}')
      hardenExistingSecureFile(targetPath)
      hardenExistingSecureFile(targetPath)
      await settle()

      expect(fake.callsFor('get', dir)).toHaveLength(2) // verify, then the post-relock read-back
      expect(fake.callsFor('setAsync', dir)).toHaveLength(1)
    })

    // The read path polls at ~2/s (#4901); a host that can never restrict must not log each time.
    it('collapses a failing read-path poll to a single attempt', () => {
      const { targetPath } = existingFile()
      fake.failing.add(targetPath)

      for (let read = 0; read < 25; read++) {
        hardenExistingSecureFile(targetPath)
      }

      expect(fake.callsFor('set', targetPath)).toHaveLength(1)
    })

    it('re-probes a long-failing path once its backoff has elapsed', () => {
      const { targetPath } = existingFile()
      fake.failing.add(targetPath)
      let clock = performance.now()
      const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)

      for (let step = 0; step < 48; step++) {
        hardenExistingSecureFile(targetPath)
        clock += 31 * 60_000
      }

      expect(fake.callsFor('set', targetPath)).toHaveLength(48)
      now.mockRestore()
    })

    it('LRU-evicts file entries and safely re-checks an evicted path', () => {
      __resetSecureFileHardenedPathsForTests({
        maxEntries: 2,
        maxKeyBytes: 4096,
        maxTotalKeyBytes: 8192
      })
      const dir = tempDir()
      const paths = ['first.json', 'second.json', 'third.json'].map((name) => join(dir, name))
      for (const path of paths) {
        writeFileSync(path, '{}')
        hardenExistingSecureFile(path)
      }

      hardenExistingSecureFile(paths[0]!)

      const checked = fake
        .callsFor('get')
        .map((call) => call.path)
        .filter((path) => paths.includes(path))
      expect(checked.filter((path) => path === paths[0])).toHaveLength(3) // verify, read-back, re-check
      expect(__getSecureFileHardeningCacheStateForTests().paths).toMatchObject({ entries: 2 })
    })

    it('LRU-evicts directory entries instead of retaining every path', () => {
      __resetSecureFileHardenedPathsForTests({
        maxEntries: 2,
        maxKeyBytes: 4096,
        maxTotalKeyBytes: 8192
      })
      const root = tempDir()
      const files = ['first', 'second', 'third'].map((name) => {
        mkdirSync(join(root, name))
        const file = join(root, name, 'secret.json')
        writeFileSync(file, '{}')
        return file
      })
      for (const file of files) {
        hardenExistingSecureFile(file)
      }
      expect(__getSecureFileHardeningCacheStateForTests().directories).toMatchObject({
        entries: 2
      })
    })
  })

  // The prefix comes from the host's toNamespacedPath, which is the identity off Windows.
  it.runIf(process.platform === 'win32')(
    'hands the addon extended-length paths past MAX_PATH',
    () => {
      const longPath = `C:\\Users\\me\\.orca\\${'d'.repeat(300)}\\secret.json`
      const loaded = loadWindowsSecurity()

      expect('error' in loaded ? null : loaded.addon.getDaclAces(longPath)).toBeTruthy()
      expect(fake.callsFor('get')[0]?.addonPath).toBe(`\\\\?\\${longPath}`)
    }
  )

  // A grant reads the DACL and writes back a merge; racing a re-lock it could restore the broad one.
  it('runs async DACL writes to the same path one after another', async () => {
    const loaded = loadWindowsSecurity()
    if ('error' in loaded) {
      throw new Error('fake not installed')
    }
    fake.holdAsync = true
    const order: string[] = []
    const relock = loaded.addon
      .setDaclSddlAsync('C:\\Orca', 'D:P(A;OICI;FA;;;SY)')
      .then(() => order.push('relock'))
    const grant = loaded.addon
      .grantAccessAsync('c:\\orca', FAKE_USER_SID, 0x1f01ff, { inheritable: true, replace: true })
      .then(() => order.push('grant'))
    await settle()

    // The grant waits for the parked re-lock on the same path, whatever its letter case.
    expect(fake.callsFor('grantAsync')).toEqual([])
    fake.releaseAsync()
    await Promise.all([relock, grant])
    expect(order).toEqual(['relock', 'grant'])
  })
})
