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
})
