import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessSyncMock } = vi.hoisted(() => ({ runProcessSyncMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcessSync: runProcessSyncMock }))

function regResult(stdout: string, code = 0) {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

async function loadReader() {
  return (await import('./openssh-default-shell.js')).readOpenSshDefaultShell
}

describe('readOpenSshDefaultShell', () => {
  beforeEach(() => {
    vi.resetModules()
    runProcessSyncMock.mockReset()
  })

  it('reads and memoizes the OpenSSH DefaultShell registry value', async () => {
    runProcessSyncMock.mockReturnValue(
      regResult(
        [
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH',
          '    DefaultShell    REG_SZ    C:\\Program Files\\PowerShell\\7\\pwsh.exe'
        ].join('\r\n')
      )
    )
    const read = await loadReader()

    expect(read()).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(read()).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
    expect(runProcessSyncMock).toHaveBeenCalledWith({
      program: expect.stringMatching(/System32[\\/]reg\.exe$/),
      args: ['query', 'HKLM\\SOFTWARE\\OpenSSH', '/v', 'DefaultShell'],
      timeoutMs: 3000
    })
  })

  it('treats malformed output as empty', async () => {
    runProcessSyncMock.mockReturnValue(
      regResult(
        [
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH',
          '    DefaultShellCommandOption    REG_SZ    /c'
        ].join('\r\n')
      )
    )

    expect((await loadReader())()).toBe('')
  })

  it('treats a missing value (non-zero exit) as empty', async () => {
    runProcessSyncMock.mockReturnValue(regResult('    DefaultShell    REG_SZ    C:\\x.exe', 1))

    expect((await loadReader())()).toBe('')
  })

  it('treats a spawn failure as empty', async () => {
    runProcessSyncMock.mockImplementation(() => {
      throw new Error('reg.exe failed')
    })

    expect((await loadReader())()).toBe('')
  })
})
