import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { cleanupE2ECrashpad } from './electron-crashpad-cleanup'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

const profile = '/tmp/test profile'
const database = path.join(profile, 'Crashpad')
const reporter = `/Electron Framework/Helpers/chrome_crashpad_handler --database=${database} --annotation=prod=Electron`

afterEach(() => vi.restoreAllMocks())

describe('test-owned macOS Crashpad cleanup', () => {
  it('terminates only the reporter for the exact temporary profile after rechecking ownership', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.mocked(execFileSync)
      .mockReturnValueOnce(
        `111 ${reporter}\n222 ${reporter.replace('Crashpad ', 'Crashpad-old ')}\n333 ${reporter.replace('test profile', 'another profile')}\n444 /bin/echo --database=${database} \n`
      )
      .mockReturnValueOnce(reporter)
    cleanupE2ECrashpad(profile)
    expect(kill).toHaveBeenCalledExactlyOnceWith(111, 'SIGTERM')
    expect(execFileSync).toHaveBeenLastCalledWith('ps', ['-p', '111', '-o', 'command='], {
      encoding: 'utf8',
      timeout: 5_000
    })
  })

  it('does not signal a PID whose ownership changed after enumeration', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.mocked(execFileSync).mockReturnValueOnce(`111 ${reporter}`).mockReturnValueOnce('/bin/sh')
    cleanupE2ECrashpad(profile)
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux'] as const)('does not enumerate processes on %s', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    vi.mocked(execFileSync).mockClear()
    cleanupE2ECrashpad(profile)
    expect(execFileSync).not.toHaveBeenCalled()
  })
})
