import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessSyncMock } = vi.hoisted(() => ({ runProcessSyncMock: vi.fn() }))
vi.mock('./child-process/run-process', () => ({ runProcessSync: runProcessSyncMock }))

import {
  getProcessStartTimes,
  getShipItLivenessForBundle,
  isRecordedProcessAlive
} from './shipit-liveness'

const BUNDLE = '/Applications/Orca.app'
const SHIPIT = `${BUNDLE}/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt`
const SHIPIT_FRAMEWORK_ROOT = `${BUNDLE}/Contents/Frameworks/Squirrel.framework/Resources/ShipIt`

const psOutput = (...lines: string[]): void => {
  runProcessSyncMock.mockReturnValue({
    code: 0,
    stdout: lines.join('\n'),
    stderr: '',
    outputTruncated: false
  })
}

// Why: these assert darwin-only behaviour, and CI runs Linux.
const originalPlatform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

describe('isShipItRunningForBundle', () => {
  it('detects the installer for this bundle', () => {
    psOutput('/sbin/launchd', `${SHIPIT} com.stablyai.orca.ShipIt /tmp/state.plist`)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('live')
  })

  it('matches an installer invoked with no arguments', () => {
    psOutput(SHIPIT)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('live')
  })

  it('matches the framework-root resource path used by production ShipIt launches', () => {
    psOutput(`${SHIPIT_FRAMEWORK_ROOT} com.stablyai.orca.ShipIt /tmp/state.plist`)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('live')
  })

  it('ignores a process that merely mentions the path', () => {
    // A substring match would count a grep, an editor, or this probe's own shell.
    psOutput(`/usr/bin/grep -r ${SHIPIT} /Users/someone/notes`)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('exited')
  })

  it('does not treat a similarly named binary as this installer', () => {
    psOutput(`${SHIPIT}-other --run`)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('exited')
  })

  it('ignores an installer belonging to a different bundle', () => {
    psOutput(
      '/Applications/Other.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'
    )
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('exited')
  })

  it('reports unverifiable when ps fails — failing to look is not proof of absence', () => {
    runProcessSyncMock.mockReturnValue({
      code: 1,
      stdout: '',
      stderr: 'denied',
      outputTruncated: false
    })
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('unverifiable')
  })

  it('reports unverifiable when ps throws rather than claiming the installer exited', () => {
    runProcessSyncMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('unverifiable')
  })

  it('reports unverifiable when the process table was truncated', () => {
    runProcessSyncMock.mockReturnValue({ code: 0, stdout: '', stderr: '', outputTruncated: true })
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('unverifiable')
  })

  it('bounds the probe so a wedged ps cannot stall startup', () => {
    psOutput('')
    getShipItLivenessForBundle(BUNDLE)
    expect(runProcessSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/bin/ps', timeoutMs: 2_000 })
    )
  })
})

describe('process identity', () => {
  it('recognizes the exact process that wrote a marker', () => {
    runProcessSyncMock.mockReturnValue({
      code: 0,
      stdout: ' 4242 Thu Sep  3 12:34:56 2026\n',
      stderr: '',
      timedOut: false,
      outputTruncated: false
    })

    const starts = getProcessStartTimes([4242])

    expect(isRecordedProcessAlive(4242, Date.parse('Thu Sep 3 12:34:56 2026'), starts)).toBe(true)
  })

  it('does not mistake a recycled pid for the marker writer', () => {
    runProcessSyncMock.mockReturnValue({
      code: 0,
      stdout: ' 4242 Thu Sep  3 12:44:56 2026\n',
      stderr: '',
      timedOut: false,
      outputTruncated: false
    })

    const starts = getProcessStartTimes([4242])

    expect(isRecordedProcessAlive(4242, Date.parse('Thu Sep 3 12:34:56 2026'), starts)).toBe(false)
  })

  it('batches marker writers into one bounded probe', () => {
    runProcessSyncMock.mockReturnValue({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      outputTruncated: false
    })

    getProcessStartTimes([42, 84, 42])

    expect(runProcessSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/bin/ps',
        args: ['-p', '42,84', '-o', 'pid=,lstart='],
        timeoutMs: 500
      })
    )
  })

  it('fails open when process identity cannot be verified', () => {
    runProcessSyncMock.mockReturnValue({
      code: 1,
      stdout: '',
      stderr: 'denied',
      timedOut: false,
      outputTruncated: false
    })

    expect(isRecordedProcessAlive(4242, Date.now(), getProcessStartTimes([4242]))).toBe(false)
  })

  it('does not probe when no marker exists', () => {
    runProcessSyncMock.mockClear()
    expect(getProcessStartTimes([])).toEqual(new Map())
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })
})
