import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSecureFileHardenedPathsForTests,
  __resetSecureFileWindowsUserSidForTests,
  hardenExistingSecureFile,
  hardenSecurePath,
  writeSecureFile
} from './secure-file'

vi.mock('child_process', () => ({
  execFileSync: vi.fn()
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
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === 'C:\\Windows\\System32\\whoami.exe') {
        return '"USER","S-1-5-21-1000"'
      }
      return ''
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

    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      'C:\\Windows\\System32\\whoami.exe',
      ['/user', '/fo', 'csv', '/nh'],
      expect.objectContaining({ encoding: 'utf-8' })
    )
    const [, powershellArgs, powershellOptions] = vi.mocked(execFileSync).mock.calls[1]!
    expect(vi.mocked(execFileSync).mock.calls[1]![0]).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
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
    expect(powershellOptions).toEqual(
      expect.objectContaining({ stdio: 'ignore', windowsHide: true, timeout: 5000 })
    )
  })

  it('adds inheritable rules when hardening a Windows directory', () => {
    hardenSecurePath('C:\\Users\\me\\.orca', { isDirectory: true, platform: 'win32' })

    const powershellArgs = vi.mocked(execFileSync).mock.calls[1]![1] as string[]
    expect(powershellArgs.at(-1)).toBe('1')
    expect(powershellArgs[5]).toContain('ContainerInherit')
    expect(powershellArgs[5]).toContain('ObjectInherit')
  })

  it('keeps Windows hardening best-effort when ACL rewriting fails', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => '"USER","S-1-5-21-1000"')
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('access denied')
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

    expect(getPowerShellCalls()).toHaveLength(3)
    expect(getPowerShellCalls().map(getPowerShellTarget)).toEqual([
      userDataPath,
      targetPath,
      targetPath
    ])
  })

  it('retries existing-file hardening after a failed ACL rewrite', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')
    let powershellCalls = 0
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === 'C:\\Windows\\System32\\whoami.exe') {
        return '"USER","S-1-5-21-1000"'
      }
      powershellCalls += 1
      if (powershellCalls === 2) {
        throw new Error('access denied')
      }
      return ''
    })

    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

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

    const powershellTargets = getPowerShellCalls().map(getPowerShellTarget)
    expect(powershellTargets).toHaveLength(5)
    expect(powershellTargets.filter((entry) => entry === userDataPath)).toHaveLength(1)
    expect(powershellTargets.filter((entry) => entry === targetPath)).toHaveLength(2)
  })
})

function getPowerShellCalls(): unknown[][] {
  return vi
    .mocked(execFileSync)
    .mock.calls.filter(([file]) => String(file).endsWith('WindowsPowerShell\\v1.0\\powershell.exe'))
}

function getPowerShellTarget(call: unknown[]): string {
  return (call[1] as string[])[6]!
}

async function waitForFileTimestampTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
