import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSecureFileHardenedPathsForTests,
  __resetSecureFileWindowsUserSidForTests,
  hardenExistingSecureFile,
  hardenSecurePath,
  writeSecureFile
} from './secure-file'

const posixModeIt = process.platform === 'win32' ? it.skip : it

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn()
}))

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
    vi.mocked(execFileSync).mockReset()
    vi.mocked(execFile).mockReset()
    // execFileSync handles whoami.exe (SID lookup) and the SYNCHRONOUS PowerShell file-ACL
    // path used by writeSecureFile. The directory + read-path re-harden use async execFile.
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === 'C:\\Windows\\System32\\whoami.exe') {
        return '"USER","S-1-5-21-1000"'
      }
      // Synchronous PowerShell ACL apply succeeds (returns empty stdout).
      return ''
    })
    // Directory + read-path PowerShell is called asynchronously; simulate immediate success
    vi.mocked(execFile).mockImplementation((_file, _args, _opts, callback) => {
      if (typeof callback === 'function') {
        callback(null, '', '')
      }
      return {} as ReturnType<typeof execFile>
    })
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

  it('rewrites Windows ACLs through the system PowerShell path', () => {
    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })

    // whoami.exe called synchronously to obtain SID
    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      'C:\\Windows\\System32\\whoami.exe',
      ['/user', '/fo', 'csv', '/nh'],
      expect.objectContaining({ encoding: 'utf-8' })
    )
    // PowerShell called asynchronously
    const [powershellFile, powershellArgs, powershellOptions] = vi.mocked(execFile).mock.calls[0]!
    expect(powershellFile).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(powershellArgs).toEqual(
      expect.arrayContaining([
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        'C:\\Users\\me\\.orca\\secret.json',
        'S-1-5-21-1000',
        '0'
      ])
    )
    const script = (powershellArgs as string[])[5]!
    expect(script).toContain('SetAccessRuleProtection($true, $false)')
    expect(script).toContain('RemoveAccessRuleSpecific')
    expect(script).toContain('Unexpected ACL entry')
    expect(powershellOptions).toEqual(expect.objectContaining({ windowsHide: true, timeout: 5000 }))
  })

  it('adds inheritable rules when hardening a Windows directory', () => {
    hardenSecurePath('C:\\Users\\me\\.orca', { isDirectory: true, platform: 'win32' })

    const powershellArgs = vi.mocked(execFile).mock.calls[0]![1] as string[]
    expect(powershellArgs.at(-1)).toBe('1')
    expect(powershellArgs[5]).toContain('ContainerInherit')
    expect(powershellArgs[5]).toContain('ObjectInherit')
  })

  it('keeps Windows hardening best-effort when ACL rewriting fails', () => {
    // Simulate async PowerShell failure — the callback receives an error
    vi.mocked(execFile).mockImplementationOnce((_file, _args, _opts, callback) => {
      if (typeof callback === 'function') {
        callback(new Error('access denied'), '', '')
      }
      return {} as ReturnType<typeof execFile>
    })

    expect(() =>
      hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
        isDirectory: false,
        platform: 'win32'
      })
    ).not.toThrow()
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
    expect(getPowerShellCalls()).toHaveLength(2)
    expect(getPowerShellCalls().map(getPowerShellTarget)).toEqual([userDataPath, targetPath])
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
    expect(getPowerShellCalls()).toHaveLength(3)
    expect(getPowerShellCalls().map(getPowerShellTarget)).toEqual([
      userDataPath,
      targetPath,
      targetPath
    ])
  })

  it('keeps post-rename target hardening on every write while caching the directory', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'first')
    writeSecureFile(targetPath, 'second')

    // The DIRECTORY is hardened async + path-cached: exactly once across both writes.
    const asyncTargets = getPowerShellCalls().map(getPowerShellTarget)
    expect(asyncTargets).toEqual([userDataPath])

    // The credential FILES (tmpFile + renamed target) are hardened SYNCHRONOUSLY on each write.
    // write 1: tmpFile(1) + targetFile(1) = 2; write 2: tmpFile(1) + targetFile(1) = 2; total 4.
    const syncTargets = getSyncPowerShellCalls().map(getPowerShellTarget)
    expect(syncTargets).toHaveLength(4)
    expect(syncTargets.filter((entry) => entry === targetPath)).toHaveLength(2)
    // No directory should be hardened via the synchronous path.
    expect(syncTargets.filter((entry) => entry === userDataPath)).toHaveLength(0)
  })

  // Regression test: #4901 — env-store reads at ~2×/s caused a PowerShell storm because the
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
    const dirCalls = getPowerShellCalls().filter(
      (call) => getPowerShellTarget(call) === userDataPath
    )
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

    const fileCalls = getPowerShellCalls().filter(
      (call) => getPowerShellTarget(call) === targetPath
    )
    expect(fileCalls).toHaveLength(1)
  })

  it('applies the read-path ACL asynchronously without blocking (async execFile)', () => {
    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })

    // The default (read/dir) path must launch PowerShell via execFile (async), never sync.
    expect(getSyncPowerShellCalls()).toHaveLength(0)
    expect(getPowerShellCalls()).toHaveLength(1)
  })

  // Security regression guard (#5006 review finding): writeSecureFile must restrict the
  // credential FILE's ACL SYNCHRONOUSLY before returning. On Windows writeFileSync({mode})
  // is a no-op, so an async file ACL would leave the credential briefly readable under the
  // parent's inherited (broader) ACL for the ~1-1.5s PowerShell cold-start window.
  it('hardens the credential file synchronously while keeping the directory async', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'contents')

    // Directory: async only.
    expect(getPowerShellCalls().map(getPowerShellTarget)).toEqual([userDataPath])
    // File (tmpFile + renamed target): synchronous only — no async file ACL window.
    const syncTargets = getSyncPowerShellCalls().map(getPowerShellTarget)
    expect(syncTargets).toContain(targetPath)
    expect(syncTargets.filter((entry) => entry === userDataPath)).toHaveLength(0)
    // The final published target's ACL must have been applied via the synchronous path.
    expect(getPowerShellCalls().map(getPowerShellTarget)).not.toContain(targetPath)
  })

  // Nit #1 (review): the synchronous file path must cache as hardened ONLY on confirmed
  // success, so a failed ACL apply is retried on the next write instead of being silently
  // trusted.
  it('retries the credential-file ACL on the next write when the sync apply fails', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    // First write: the synchronous PowerShell ACL apply throws for every powershell call.
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === 'C:\\Windows\\System32\\whoami.exe') {
        return '"USER","S-1-5-21-1000"'
      }
      throw new Error('access denied')
    })
    expect(() => writeSecureFile(targetPath, 'first')).not.toThrow()
    const firstWriteTargetCalls = getSyncPowerShellCalls()
      .map(getPowerShellTarget)
      .filter((entry) => entry === targetPath)
    expect(firstWriteTargetCalls).toHaveLength(1)

    // Second write: ACL apply now succeeds. Because the failed apply was NOT cached, the
    // target file is hardened again rather than skipped.
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === 'C:\\Windows\\System32\\whoami.exe') {
        return '"USER","S-1-5-21-1000"'
      }
      return ''
    })
    writeSecureFile(targetPath, 'second')
    const allTargetCalls = getSyncPowerShellCalls()
      .map(getPowerShellTarget)
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

    const dirCalls = getPowerShellCalls().filter(
      (call) => getPowerShellTarget(call) === userDataPath
    )
    expect(dirCalls).toHaveLength(1)
  })

  // win32-only guard: on non-win32 platforms no PowerShell is ever spawned (sync or async);
  // POSIX hardening uses chmodSync only.
  it('never spawns PowerShell on non-win32 platforms', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'contents')
    hardenExistingSecureFile(targetPath)

    expect(getPowerShellCalls()).toHaveLength(0)
    expect(getSyncPowerShellCalls()).toHaveLength(0)
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
})

const POWERSHELL_SUFFIX = 'WindowsPowerShell\\v1.0\\powershell.exe'

// Async PowerShell calls (directory hardening + read-path file re-harden).
function getPowerShellCalls(): unknown[][] {
  return vi.mocked(execFile).mock.calls.filter(([file]) => String(file).endsWith(POWERSHELL_SUFFIX))
}

// Synchronous PowerShell calls (credential-file ACL on the write path).
function getSyncPowerShellCalls(): unknown[][] {
  return vi
    .mocked(execFileSync)
    .mock.calls.filter(([file]) => String(file).endsWith(POWERSHELL_SUFFIX))
}

function getPowerShellTarget(call: unknown[]): string {
  return (call[1] as string[])[6]!
}

async function waitForFileTimestampTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}
