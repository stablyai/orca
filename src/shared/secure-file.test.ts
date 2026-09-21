import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, runProcessSync } from './child-process/run-process'
import { mayAttemptHardening } from './secure-path-hardening-retry-budget'
import {
  __getSecureFileHardeningCacheStateForTests,
  __resetSecureFileHardenedPathsForTests,
  __resetSecureFileWindowsUserSidForTests,
  hardenExistingSecureFile,
  hardenSecurePath,
  isUnreadableError,
  writeSecureFile
} from './secure-file'

const posixModeIt = process.platform === 'win32' ? it.skip : it

vi.mock('./child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const USER_SID = 'S-1-5-21-1000'

type FakeSpec = { program: string; args?: readonly string[] }

/** Paths the fake considers already hardened, with the ACE flags the grant pass used. */
const hardenedByFake = new Map<string, string>()

/** Paths whose verify pass should answer with a DACL that is not the intended one. */
const forcedBadSddl = new Map<string, string>()

/**
 * Stands in for icacls. `/save` really writes a UTF-16LE SDDL file, because the code under test
 * reads that file back off disk — which also means these tests exercise the real SDDL parser
 * rather than a restatement of it.
 */
function fakeIcacls(spec: FakeSpec): typeof OK {
  const args = spec.args ?? []
  const path = args[0] ?? ''
  const grantIndex = args.indexOf('/grant:r')
  if (grantIndex !== -1) {
    const grant = args[grantIndex + 1]!
    hardenedByFake.set(path, grant.includes('(OI)(CI)') ? 'OICI' : '')
    return OK
  }
  const saveIndex = args.indexOf('/save')
  if (saveIndex === -1) {
    return OK // /reset
  }
  writeFileSync(args[saveIndex + 1]!, fakeSddl(path), 'utf16le')
  return OK
}

function fakeSddl(path: string): string {
  const forced = forcedBadSddl.get(path)
  if (forced) {
    return `name\r\n${forced}\r\n`
  }
  const aceFlags = hardenedByFake.get(path)
  if (aceFlags === undefined) {
    // Never hardened: the inherited DACL a fresh file carries, so the first verify must fail.
    return `name\r\nD:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER_SID})\r\n`
  }
  const ace = (sid: string): string => `(A;${aceFlags};FA;;;${sid})`
  return `name\r\nD:PAI${ace('BA')}${ace('SY')}${ace(USER_SID)}\r\n`
}

describe('hardenSecurePath', () => {
  const originalSystemRoot = process.env.SystemRoot
  const originalWindir = process.env.WINDIR
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const tempDirs: string[] = []

  beforeEach(() => {
    process.env.SystemRoot = 'C:\\Windows'
    delete process.env.WINDIR
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
    vi.mocked(runProcessSync).mockReset()
    vi.mocked(runProcess).mockReset()
    hardenedByFake.clear()
    forcedBadSddl.clear()
    // runProcessSync serves whoami.exe (SID lookup) and the SYNCHRONOUS icacls file-ACL path
    // used by writeSecureFile. Directory + read-path re-hardens use async runProcess.
    vi.mocked(runProcessSync).mockImplementation((spec) => {
      if (spec.program === 'C:\\Windows\\System32\\whoami.exe') {
        return { ...OK, stdout: `"USER","${USER_SID}"` }
      }
      return fakeIcacls(spec)
    })
    vi.mocked(runProcess).mockImplementation((spec) => Promise.resolve(fakeIcacls(spec)))
  })

  afterEach(() => {
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot
    } else {
      process.env.SystemRoot = originalSystemRoot
    }
    if (originalWindir === undefined) {
      delete process.env.WINDIR
    } else {
      process.env.WINDIR = originalWindir
    }
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rewrites Windows ACLs through icacls, purging explicit ACEs before granting', async () => {
    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })
    await flushAsyncAcl()

    // whoami.exe called synchronously to obtain SID
    expect(vi.mocked(runProcessSync).mock.calls[0]![0]).toMatchObject({
      program: 'C:\\Windows\\System32\\whoami.exe',
      args: ['/user', '/fo', 'csv', '/nh']
    })

    const specs = vi.mocked(runProcess).mock.calls.map(([spec]) => spec)
    expect(specs.every((spec) => spec.program === 'C:\\Windows\\System32\\icacls.exe')).toBe(true)
    // Verify runs first, so an already-correct DACL is never rewritten.
    expect(specs[0]!.args?.slice(0, 2)).toEqual(['C:\\Users\\me\\.orca\\secret.json', '/save'])
    expect(specs[1]!.args).toEqual(['C:\\Users\\me\\.orca\\secret.json', '/reset', '/q'])
    expect(specs[2]!.args).toEqual([
      'C:\\Users\\me\\.orca\\secret.json',
      '/inheritance:r',
      '/grant:r',
      `*${USER_SID}:(F)`,
      '/grant:r',
      '*S-1-5-18:(F)',
      '/grant:r',
      '*S-1-5-32-544:(F)',
      '/q'
    ])
    // The apply is read back: a loosened ACL has to be detectable, not just overwritten.
    expect(specs[3]!.args?.slice(0, 2)).toEqual(['C:\\Users\\me\\.orca\\secret.json', '/save'])
    expect(specs[2]!.timeoutMs).toBe(5000)
  })

  // BLOCKING 1: re-running /reset on an already-correct DACL restores the inherited (broader) one
  // for the few ms until the grant pass lands, for no gain. A correct DACL must be left alone.
  it('leaves an already-correct ACL untouched instead of rewriting it', async () => {
    const target = 'C:\\Users\\me\\.orca\\secret.json'
    hardenedByFake.set(target, '')

    hardenSecurePath(target, { isDirectory: false, platform: 'win32' })
    await flushAsyncAcl()

    const specs = vi.mocked(runProcess).mock.calls.map(([spec]) => spec)
    expect(specs).toHaveLength(1)
    expect(specs[0]!.args).toContain('/save')
    expect(specs.some((spec) => spec.args?.includes('/reset'))).toBe(false)
    expect(specs.some((spec) => spec.args?.includes('/grant:r'))).toBe(false)
  })

  // BLOCKING 3: the verify pass must check *identity*, not just rule count, inheritance and rights.
  // Granting Everyone full control satisfies all three of those and is the failure it exists for.
  it.each([
    ['full control to Everyone', 'D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;WD)', 'S-1-1-0'],
    ['a deny rule', `D:PAI(D;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${USER_SID})`, 'unexpected D rule'],
    ['an unprotected DACL', `D:AI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${USER_SID})`, 'not protected'],
    [
      'a surviving inherited rule',
      `D:PAI(A;ID;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${USER_SID})`,
      'inherited'
    ],
    ['read-only rights', `D:PAI(A;;FR;;;BA)(A;;FA;;;SY)(A;;FA;;;${USER_SID})`, 'not full control']
  ])('rejects a verified DACL granting %s', async (_label, sddl, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const target = 'C:\\Users\\me\\.orca\\secret.json'
    forcedBadSddl.set(target, sddl)

    hardenSecurePath(target, { isDirectory: false, platform: 'win32' })
    await flushAsyncAcl()

    expect(warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({
        stage: 'verify',
        detail: expect.stringContaining(expected)
      })
    )
    warn.mockRestore()
  })

  /**
   * Evicting the cache on every failed apply is the #4901 storm wearing a different hat: the env
   * store re-hardens on the *read* path at ~2/s, so on a host where hardening legitimately cannot
   * work (FAT32, network path, restricted token) that is two icacls spawns and two warnings a
   * second, forever.
   *
   * The curve itself is pinned in secure-path-hardening-retry-budget.test.ts; what matters here is
   * that the read path is actually wired to it.
   */
  it('collapses a failing read-path poll to a single attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const targetPath = writeFailingHardenTarget()

    for (let read = 0; read < 25; read++) {
      hardenExistingSecureFile(targetPath)
      await flushAsyncAcl()
    }

    expect(attemptsFor(targetPath)).toHaveLength(1)
    warn.mockRestore()
  })

  /**
   * A budget that expires rather than latching: three transient failures used to abandon a path
   * for the life of the process, so one AV scan or momentary lock left every later credential
   * write unprotected on a host where hardening would now succeed.
   */
  it('re-probes a long-failing path once its backoff has elapsed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const targetPath = writeFailingHardenTarget()
    let clock = performance.now()
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)

    // A day of failing, well past any fixed cap, stepping by more than the 30-minute ceiling.
    for (let step = 0; step < 48; step++) {
      hardenExistingSecureFile(targetPath)
      await flushAsyncAcl()
      clock += 31 * 60_000
    }

    expect(attemptsFor(targetPath)).toHaveLength(48)
    now.mockRestore()
    warn.mockRestore()
  })

  it('reports recovery when a previously throttled path hardens again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const targetPath = writeFailingHardenTarget()
    let clock = performance.now()
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)

    // Three failures to reach the announced degraded state, each past its own backoff.
    for (const wait of [0, 61_000, 121_000]) {
      clock += wait
      hardenExistingSecureFile(targetPath)
      await flushAsyncAcl()
    }
    expect(throttleReports(warn, targetPath)).toHaveLength(1)

    // The transient condition clears; the next re-probe must notice.
    clock += 5 * 60_000
    vi.mocked(runProcess).mockImplementation((spec) => Promise.resolve(fakeIcacls(spec)))
    hardenExistingSecureFile(targetPath)
    await flushAsyncAcl()

    expect(info).toHaveBeenCalledWith(
      '[secure-path.windows-acl] path hardening recovered',
      expect.objectContaining({ targetPath, stage: 'recovered' })
    )
    now.mockRestore()
    info.mockRestore()
    warn.mockRestore()
  })

  /**
   * The write path is exempt from the budget, but it was also invisible to it: a successful write
   * left the failure record standing, so the read path went on backing off for up to 30 minutes
   * after the host had demonstrably recovered, and no `recovered` transition came from this lane.
   */
  it('clears the read-path backoff when the exempt write path succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const targetPath = writeFailingHardenTarget()
    let clock = performance.now()
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)

    // Three read-path failures: the path is throttled and its next re-probe is minutes away.
    for (const wait of [0, 61_000, 121_000]) {
      clock += wait
      hardenExistingSecureFile(targetPath)
      await flushAsyncAcl()
    }
    expect(mayAttemptHardening(targetPath)).toBe(false)

    // The host recovers and a credential is written. The synchronous apply succeeds (runProcessSync
    // was never made to fail), so the read path must stop backing off.
    writeSecureFile(targetPath, 'contents')

    expect(mayAttemptHardening(targetPath)).toBe(true)
    expect(info).toHaveBeenCalledWith(
      '[secure-path.windows-acl] path hardening recovered',
      expect.objectContaining({ targetPath, stage: 'recovered' })
    )
    now.mockRestore()
    info.mockRestore()
    warn.mockRestore()
  })

  /**
   * The SID lookup's own one-minute latch, which is the read-path budget's twin and strictly
   * worse: a failed lookup makes the plan null, disabling the *synchronous write* path too — so
   * the write-path exemption that recovers the budget cannot recover this. Measured against the
   * wall clock, a backwards step held it shut for the whole length of the step.
   */
  it('re-probes the user SID after a backwards clock step', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    let clock = performance.now()
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let wallClock = Date.parse('2026-01-01T00:00:00Z')
    const wallNow = vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    let sidLookupFails = true
    vi.mocked(runProcessSync).mockImplementation((spec) => {
      if (spec.program === 'C:\\Windows\\System32\\whoami.exe') {
        return sidLookupFails ? { ...OK, code: 1 } : { ...OK, stdout: `"USER","${USER_SID}"` }
      }
      return fakeIcacls(spec)
    })

    // No SID, so no plan, so hardening is off entirely — not merely throttled.
    expect(writeSecureFile(targetPath, 'first')).toBe(false)

    // A minute of real time passes while the wall clock steps back a year.
    clock += 61_000
    wallClock -= 365 * 24 * 60 * 60_000
    sidLookupFails = false

    expect(writeSecureFile(targetPath, 'second')).toBe(true)
    wallNow.mockRestore()
    now.mockRestore()
    warn.mockRestore()
  })

  // Scoped to one path: the parent directory is hardened too, and reports its own transition.
  function throttleReports(warn: ReturnType<typeof vi.spyOn>, targetPath: string): unknown[] {
    return warn.mock.calls.filter((call) => {
      const entry = call[1] as { stage?: string; targetPath?: string } | undefined
      return entry?.stage === 'throttled' && entry.targetPath === targetPath
    })
  }

  function writeFailingHardenTarget(): string {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')
    vi.mocked(runProcess).mockResolvedValue({ ...OK, code: 5, stderr: 'Access is denied.' })
    return targetPath
  }

  function attemptsFor(targetPath: string): { args?: readonly string[] }[] {
    return getHardenAclCalls().filter((spec) => getAclTarget(spec) === targetPath)
  }

  // /c makes icacls exit 0 while printing "Failed processing 1 files" — a silent no-op by another route.
  it('never passes the icacls /c continue-on-error flag', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    // Cover both runners: the write path is synchronous, the directory re-harden is not.
    writeSecureFile(join(userDataPath, 'secret.json'), 'contents')
    hardenSecurePath('C:\\Users\\me\\.orca\\other.json', {
      isDirectory: false,
      platform: 'win32'
    })
    await flushAsyncAcl()

    const specs = [
      ...vi.mocked(runProcess).mock.calls.map(([spec]) => spec),
      ...vi.mocked(runProcessSync).mock.calls.map(([spec]) => spec)
    ]
    expect(specs.length).toBeGreaterThan(4)
    for (const spec of specs) {
      expect(spec.args).not.toContain('/c')
    }
  })

  it('adds inheritable rules when hardening a Windows directory', async () => {
    hardenSecurePath('C:\\Users\\me\\.orca', { isDirectory: true, platform: 'win32' })
    await flushAsyncAcl()

    const grantArgs = vi
      .mocked(runProcess)
      .mock.calls.map(([spec]) => spec.args as string[])
      .find((args) => args.includes('/grant:r'))!
    expect(grantArgs).toContain(`*${USER_SID}:(OI)(CI)(F)`)
    expect(grantArgs).toContain('*S-1-5-18:(OI)(CI)(F)')
  })

  it('keeps Windows hardening best-effort when ACL rewriting fails', async () => {
    vi.mocked(runProcess).mockRejectedValue(new Error('access denied'))

    expect(() =>
      hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
        isDirectory: false,
        platform: 'win32'
      })
    ).not.toThrow()
    await expect(flushAsyncAcl()).resolves.toBeUndefined()
  })

  // The old PowerShell command line never reached the grant step at all, so a failure had to be
  // visible somewhere; "best effort" may not mean "undetectable".
  it('logs when a Windows ACL apply fails instead of swallowing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(runProcess).mockResolvedValue({ ...OK, code: 5, stderr: 'Access is denied.' })

    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })
    await flushAsyncAcl()

    expect(warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({
        targetPath: 'C:\\Users\\me\\.orca\\secret.json',
        stage: 'reset',
        detail: 'Access is denied.'
      })
    )
    warn.mockRestore()
  })

  it('reports a failed synchronous ACL apply to the caller and the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.mocked(runProcessSync).mockImplementation((spec) => {
      if (spec.program === 'C:\\Windows\\System32\\whoami.exe') {
        return { ...OK, stdout: '"USER","S-1-5-21-1000"' }
      }
      return { ...OK, code: 5, stderr: 'Access is denied.' }
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)

    writeSecureFile(join(userDataPath, 'secret.json'), 'contents')

    expect(warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({ stage: 'reset', detail: 'Access is denied.' })
    )
    warn.mockRestore()
  })

  // Paths past MAX_PATH make icacls report "cannot find the path specified"; the extended prefix is the escape.
  it('uses the extended-length prefix for paths past MAX_PATH', async () => {
    const longPath = `C:\\Users\\me\\.orca\\${'d'.repeat(300)}\\secret.json`
    hardenSecurePath(longPath, { isDirectory: false, platform: 'win32' })
    await flushAsyncAcl()

    for (const [spec] of vi.mocked(runProcess).mock.calls) {
      expect(spec.args![0]).toBe(`\\\\?\\${longPath}`)
    }
  })

  it('caches successful existing-file hardening within a process', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

    // dir hardened once (path-cached), file hardened once (metadata-cached) — 2 total
    expect(getHardenAclCalls()).toHaveLength(2)
    expect(getHardenAclCalls().map(getAclTarget)).toEqual([userDataPath, targetPath])
  })

  it('LRU-evicts Windows file hardening entries and safely re-hardens an evicted path', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __resetSecureFileHardenedPathsForTests({
      maxEntries: 2,
      maxKeyBytes: 4096,
      maxTotalKeyBytes: 8192
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const paths = ['first.json', 'second.json', 'third.json'].map((name) =>
      join(userDataPath, name)
    )
    for (const path of paths) {
      writeFileSync(path, '{}')
      hardenExistingSecureFile(path)
    }

    hardenExistingSecureFile(paths[0]!)

    const fileTargets = getHardenAclCalls()
      .map(getAclTarget)
      .filter((path) => paths.includes(path))
    expect(fileTargets).toEqual([...paths, paths[0]])
    expect(__getSecureFileHardeningCacheStateForTests().paths).toMatchObject({
      entries: 2
    })
  })

  it('LRU-evicts Windows directory hardening entries instead of retaining every path', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __resetSecureFileHardenedPathsForTests({
      maxEntries: 2,
      maxKeyBytes: 4096,
      maxTotalKeyBytes: 8192
    })
    const root = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(root)
    const directories = ['first', 'second', 'third'].map((name) => join(root, name))
    const files = directories.map((dir) => {
      mkdirSync(dir)
      const file = join(dir, 'secret.json')
      writeFileSync(file, '{}')
      return file
    })
    for (const file of files) {
      hardenExistingSecureFile(file)
    }

    hardenExistingSecureFile(files[0]!)

    const directoryTargets = getHardenAclCalls()
      .map(getAclTarget)
      .filter((path) => directories.includes(path))
    expect(directoryTargets).toEqual([...directories, directories[0]])
    expect(__getSecureFileHardeningCacheStateForTests().directories).toMatchObject({
      entries: 2
    })
  })

  it('re-hardens an existing file when its metadata changes after caching', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    await waitForFileTimestampTick()
    writeFileSync(targetPath, '{"changed":true}')
    hardenExistingSecureFile(targetPath)

    // call 1: dir + file. call 2: dir skipped (path-cached), file re-hardened (new mtime)
    expect(getHardenAclCalls()).toHaveLength(3)
    expect(getHardenAclCalls().map(getAclTarget)).toEqual([userDataPath, targetPath, targetPath])
  })

  it('keeps post-rename target hardening on every write while caching the directory', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'first')
    writeSecureFile(targetPath, 'second')

    // The DIRECTORY is hardened async + path-cached: exactly once across both writes.
    const asyncTargets = getHardenAclCalls().map(getAclTarget)
    expect(asyncTargets).toEqual([userDataPath])

    // The credential FILES (tmpFile + renamed target) are hardened SYNCHRONOUSLY on each write.
    // write 1: tmpFile(1) + targetFile(1) = 2; write 2: tmpFile(1) + targetFile(1) = 2; total 4.
    const syncTargets = getSyncHardenAclCalls().map(getAclTarget)
    expect(syncTargets).toHaveLength(4)
    expect(syncTargets.filter((entry) => entry === targetPath)).toHaveLength(2)
    // No directory should be hardened via the synchronous path.
    expect(syncTargets.filter((entry) => entry === userDataPath)).toHaveLength(0)
  })

  // Regression test: #4901 — env-store reads at ~2×/s caused an ACL-spawn storm because the
  // parent directory mtime churned (every secure write updates it), so the mtime-keyed cache
  // never matched. Directories must be path-cached for the process lifetime.
  it('does not re-harden the parent directory when its mtime changes between reads', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    // Simulate the env-store read loop: hardenExistingSecureFile called many times while
    // another part of Orca writes to the same directory (changing its mtime).
    hardenExistingSecureFile(targetPath)
    await waitForFileTimestampTick()
    // Simulate a write to another file in the same dir (changes dir mtime)
    writeFileSync(join(userDataPath, 'other.json'), '{}')
    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

    // The parent directory must be hardened exactly ONCE despite its mtime changing
    const dirCalls = getHardenAclCalls().filter((call) => getAclTarget(call) === userDataPath)
    expect(dirCalls).toHaveLength(1)
  })

  it('does not re-harden an unchanged file on repeated reads', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

    const fileCalls = getHardenAclCalls().filter((call) => getAclTarget(call) === targetPath)
    expect(fileCalls).toHaveLength(1)
  })

  it('applies the read-path ACL asynchronously without blocking (async runProcess)', () => {
    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })

    // The default (read/dir) path must launch icacls via runProcess (async), never sync.
    expect(getSyncHardenAclCalls()).toHaveLength(0)
    expect(getHardenAclCalls()).toHaveLength(1)
  })

  // Security regression guard (#5006 review finding): writeSecureFile must restrict the
  // credential FILE's ACL SYNCHRONOUSLY before returning. On Windows writeFileSync({mode})
  // is a no-op, so an async file ACL would leave the credential briefly readable under the
  // parent's inherited (broader) ACL for the duration of the spawn.
  it('hardens the credential file synchronously while keeping the directory async', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'contents')

    // Directory: async only.
    expect(getHardenAclCalls().map(getAclTarget)).toEqual([userDataPath])
    // File (tmpFile + renamed target): synchronous only — no async file ACL window.
    const syncTargets = getSyncHardenAclCalls().map(getAclTarget)
    expect(syncTargets).toContain(targetPath)
    expect(syncTargets.filter((entry) => entry === userDataPath)).toHaveLength(0)
    // The final published target's ACL must have been applied via the synchronous path.
    expect(getHardenAclCalls().map(getAclTarget)).not.toContain(targetPath)
  })

  // Nit #1 (review): the synchronous file path must cache as hardened ONLY on confirmed
  // success, so a failed ACL apply is retried on the next write instead of being silently
  // trusted.
  it('retries the credential-file ACL on the next write when the sync apply fails', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    // First write: the synchronous icacls ACL apply throws for every icacls call.
    vi.mocked(runProcessSync).mockImplementation((spec) => {
      if (spec.program === 'C:\\Windows\\System32\\whoami.exe') {
        return { ...OK, stdout: '"USER","S-1-5-21-1000"' }
      }
      throw new Error('access denied')
    })
    expect(() => writeSecureFile(targetPath, 'first')).not.toThrow()
    const firstWriteTargetCalls = getSyncHardenAclCalls()
      .map(getAclTarget)
      .filter((entry) => entry === targetPath)
    expect(firstWriteTargetCalls).toHaveLength(1)

    // Second write: ACL apply now succeeds. Because the failed apply was NOT cached, the
    // target file is hardened again rather than skipped.
    vi.mocked(runProcessSync).mockImplementation((spec) => {
      if (spec.program === 'C:\\Windows\\System32\\whoami.exe') {
        return { ...OK, stdout: '"USER","S-1-5-21-1000"' }
      }
      return OK
    })
    writeSecureFile(targetPath, 'second')
    const allTargetCalls = getSyncHardenAclCalls()
      .map(getAclTarget)
      .filter((entry) => entry === targetPath)
    expect(allTargetCalls).toHaveLength(2)
  })

  // Nit #2 (review) / hardening: the process-lifetime directory cache hardens a directory
  // exactly once even when its mtime churns across many writes (the #4901 storm condition,
  // exercised through the write path rather than the read path).
  it('hardens the directory exactly once across many writes despite mtime churn', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)

    for (let i = 0; i < 5; i++) {
      // Each write changes the directory's mtime (a new file lands in it).
      writeSecureFile(join(userDataPath, `secret-${i}.json`), `contents-${i}`)
    }

    const dirCalls = getHardenAclCalls().filter((call) => getAclTarget(call) === userDataPath)
    expect(dirCalls).toHaveLength(1)
  })

  // win32-only guard: on non-win32 platforms no icacls is ever spawned (sync or async);
  // POSIX hardening uses chmodSync only.
  it('never spawns icacls on non-win32 platforms', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'contents')
    hardenExistingSecureFile(targetPath)

    expect(getHardenAclCalls()).toHaveLength(0)
    expect(getSyncHardenAclCalls()).toHaveLength(0)
  })

  posixModeIt('re-hardens a POSIX directory when its metadata changes after caching', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    expect(statMode(userDataPath)).toBe(0o700)

    chmodSync(userDataPath, 0o755)
    hardenExistingSecureFile(targetPath)

    expect(statMode(userDataPath)).toBe(0o700)
  })

  posixModeIt('LRU-bounds POSIX hardening entries while keeping recent paths cached', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    __resetSecureFileHardenedPathsForTests({
      maxEntries: 2,
      maxKeyBytes: 4096,
      maxTotalKeyBytes: 8192
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const firstPath = join(userDataPath, 'first.json')
    const secondPath = join(userDataPath, 'second.json')
    writeFileSync(firstPath, '{}')
    writeFileSync(secondPath, '{}')

    hardenExistingSecureFile(firstPath)
    hardenExistingSecureFile(secondPath)
    expect(__getSecureFileHardeningCacheStateForTests().paths.paths).toEqual([
      userDataPath,
      secondPath
    ])

    hardenExistingSecureFile(firstPath)
    expect(__getSecureFileHardeningCacheStateForTests().paths.paths).toEqual([
      userDataPath,
      firstPath
    ])
  })
})

/**
 * Every harden opens with a `/save` verify; one that has work to do then runs `/reset`, `/grant:r`
 * and a closing `/save`. Counting only the *opening* verify keeps "one harden = one entry"
 * regardless of which of the two shapes it took.
 */
function hardenInitiations(specs: FakeSpec[]): { args?: readonly string[] }[] {
  const initiations: { args?: readonly string[] }[] = []
  const awaitingClosingVerify = new Set<string>()
  for (const spec of specs) {
    if (!spec.program.endsWith('icacls.exe')) {
      continue
    }
    const path = spec.args?.[0] ?? ''
    if (spec.args?.includes('/grant:r')) {
      awaitingClosingVerify.add(path)
    } else if (spec.args?.includes('/save')) {
      if (awaitingClosingVerify.has(path)) {
        awaitingClosingVerify.delete(path)
      } else {
        initiations.push(spec)
      }
    }
  }
  return initiations
}

// Async icacls calls (directory hardening + read-path file re-harden).
function getHardenAclCalls(): { args?: readonly string[] }[] {
  return hardenInitiations(vi.mocked(runProcess).mock.calls.map(([spec]) => spec))
}

// Synchronous icacls calls (credential-file ACL on the write path).
function getSyncHardenAclCalls(): { args?: readonly string[] }[] {
  return hardenInitiations(vi.mocked(runProcessSync).mock.calls.map(([spec]) => spec))
}

function getAclTarget(spec: { args?: readonly string[] }): string {
  return spec.args![0]!
}

// The async harden awaits three icacls passes, so let the chain settle before asserting on it.
async function flushAsyncAcl(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function waitForFileTimestampTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('isUnreadableError', () => {
  const withCode = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

  // The hardened-DACL case this predicate was written for.
  it('reports a denied read', () => {
    expect(isUnreadableError(withCode('EPERM'))).toBe(true)
    expect(isUnreadableError(withCode('EACCES'))).toBe(true)
  })

  /**
   * The likelier half on Windows: antivirus holding a credential open during startup yields
   * EBUSY, and fd exhaustion yields EMFILE. Neither says the bytes were read, so neither may
   * license a regenerate-and-overwrite.
   */
  it('reports a read that never reached the contents for any other reason', () => {
    expect(isUnreadableError(withCode('EBUSY'))).toBe(true)
    expect(isUnreadableError(withCode('EMFILE'))).toBe(true)
    expect(isUnreadableError(withCode('ENFILE'))).toBe(true)
    expect(isUnreadableError(withCode('EIO'))).toBe(true)
  })

  /**
   * The other side of the distinction, and the reason this is an allow list rather than
   * "everything except ENOENT": a missing file licenses creating one, and bytes that were read
   * and did not parse are the self-heal these stores exist to perform.
   */
  it('does not report a missing file or a parse failure', () => {
    expect(isUnreadableError(withCode('ENOENT'))).toBe(false)
    expect(isUnreadableError(new SyntaxError('Unexpected end of JSON input'))).toBe(false)
    expect(isUnreadableError(withCode('EISDIR'))).toBe(false)
    expect(isUnreadableError(undefined)).toBe(false)
  })
})
