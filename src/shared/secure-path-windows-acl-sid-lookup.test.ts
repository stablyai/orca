import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from './child-process/run-process'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

vi.mock('./child-process/run-process', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

const SID = 'S-1-5-21-1-2-3-1001'

const exited = (stdout = '', code = 0): ProcessResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

/** Dynamic: the module caches the SID for the process lifetime, so each test needs a fresh copy. */
async function loadModule() {
  vi.resetModules()
  return import('./secure-path-windows-acl.js')
}

function hardened(harden: (onSettled: (restricted: boolean) => void) => void): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  harden(resolve)
  return promise
}

beforeEach(() => {
  runProcessMock.mockReset()
  runProcessSyncMock.mockReset()
  // The reset path fails against a mocked icacls, which the reporter logs.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('the read path SID lookup', () => {
  it('spawns whoami once for concurrent and repeated hardening, and never synchronously', async () => {
    runProcessMock.mockImplementation(({ args }: { args: readonly string[] }) =>
      Promise.resolve(args[0] === '/user' ? exited(`"DOMAIN\\alice","${SID}"\r\n`) : exited())
    )
    const { bestEffortRestrictWindowsPath } = await loadModule()

    await Promise.all([
      hardened((onSettled) => bestEffortRestrictWindowsPath('C:\\a.json', false, onSettled)),
      hardened((onSettled) => bestEffortRestrictWindowsPath('C:\\b.json', false, onSettled))
    ])
    await hardened((onSettled) => bestEffortRestrictWindowsPath('C:\\c.json', false, onSettled))

    expect(runProcessMock.mock.calls.filter(([spec]) => spec.args[0] === '/user')).toHaveLength(1)
    expect(runProcessSyncMock).not.toHaveBeenCalled()
    // icacls still ran: the lookup short-circuit must not silently skip the grant.
    expect(runProcessMock.mock.calls.some(([spec]) => spec.args.includes('/reset'))).toBe(true)
  })

  it('reports an unresolvable SID and never reaches icacls', async () => {
    runProcessMock.mockResolvedValue(exited('', 1))
    const { bestEffortRestrictWindowsPath } = await loadModule()

    await expect(
      hardened((onSettled) => bestEffortRestrictWindowsPath('C:\\a.json', false, onSettled))
    ).resolves.toBe(false)

    expect(runProcessMock.mock.calls.every(([spec]) => spec.args[0] === '/user')).toBe(true)
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })
})
