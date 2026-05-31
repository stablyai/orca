import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetSecureFileWindowsUserSidForTests, hardenSecurePath } from './secure-file'

vi.mock('child_process', () => ({
  execFileSync: vi.fn()
}))

describe('hardenSecurePath', () => {
  const originalSystemRoot = process.env.SystemRoot
  const originalWindir = process.env.WINDIR

  beforeEach(() => {
    process.env.SystemRoot = 'C:\\Windows'
    delete process.env.WINDIR
    __resetSecureFileWindowsUserSidForTests()
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
})
