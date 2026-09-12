import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'

const statSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return { ...actual, statSync: (...args: unknown[]) => statSyncMock(...args) }
})

const runProcessMock = vi.hoisted(() => vi.fn())

vi.mock('./child-process/run-process', () => ({
  runProcess: (...args: unknown[]) => runProcessMock(...args)
}))

import type {
  WindowsPowerShellHostAsyncProbe,
  WindowsPowerShellHostResolution
} from './windows-powershell-host'

import {
  getWindowsPowerShellHost,
  getWindowsPowerShellHostCandidates,
  isPossibleWindowsPowerShellHost,
  probeWindowsPowerShellHostAsync,
  resetWindowsPowerShellHostCacheForTests,
  setWindowsPowerShellHostResolutionObserver,
  warmWindowsPowerShellHostCache
} from './windows-powershell-host'
const ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
  PATH: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools'
} satisfies NodeJS.ProcessEnv

const SYSTEM32_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PROGRAM_FILES_PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_APPS_PWSH = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'

const found = async (): Promise<{ ok: true; exitCode: number; markerOk: true }> => ({
  ok: true,
  exitCode: 7,
  markerOk: true
})
const missed = async (): Promise<{ ok: false; exitCode: number; markerOk: false }> => ({
  ok: false,
  exitCode: 0,
  markerOk: false
})

function throwFsError(code: string): never {
  throw Object.assign(new Error(code), { code })
}

/**
 * Does what a working host does: decode the probe payload and write the marker
 * it names. Reading the path out of the payload rather than restating it keeps
 * the fixture honest if the script shape changes.
 */
function answerProbe(spec: { args: string[] }): void {
  const script = Buffer.from(spec.args[4], 'base64').toString('utf16le')
  const quoted = /WriteAllText\('(.*?)',/.exec(script)?.[1]
  if (!quoted) {
    throw new Error(`probe payload names no marker path: ${script}`)
  }
  writeFileSync(quoted.replaceAll("''", "'"), 'orca-powershell-host-ok')
}

beforeEach(() => {
  resetWindowsPowerShellHostCacheForTests()
  statSyncMock.mockReset()
  statSyncMock.mockReturnValue({})
  runProcessMock.mockReset()
})

describe('getWindowsPowerShellHostCandidates', () => {
  it('tries every PowerShell 7 location before Windows PowerShell', () => {
    const candidates = getWindowsPowerShellHostCandidates(ENV)
    expect(candidates[0]).toBe(PROGRAM_FILES_PWSH)
    expect(candidates.at(-1)).toBe(SYSTEM32_POWERSHELL)
    expect(candidates).toContain(PROGRAM_FILES_PWSH)
    expect(candidates).toContain(WINDOWS_APPS_PWSH)
    expect(candidates).toContain('C:\\Tools\\pwsh.exe')
  })

  it('lists the WindowsApps alias once even though PATH also names it', () => {
    const candidates = getWindowsPowerShellHostCandidates(ENV)
    expect(candidates.filter((entry) => entry === WINDOWS_APPS_PWSH)).toHaveLength(1)
  })
})

describe('isPossibleWindowsPowerShellHost', () => {
  it('rules out a path that is definitively missing', () => {
    statSyncMock.mockImplementation(() => throwFsError('ENOENT'))
    expect(isPossibleWindowsPowerShellHost(PROGRAM_FILES_PWSH)).toBe(false)
  })

  // Why: the Store build of PowerShell 7 is reached through an App Execution
  // Alias, a reparse point that runs but answers stat with EACCES. Treating any
  // stat failure as missing threw away the only working host on such a machine.
  it('keeps a candidate whose stat fails for a reason other than absence', () => {
    statSyncMock.mockImplementation(() => throwFsError('EACCES'))
    expect(isPossibleWindowsPowerShellHost(WINDOWS_APPS_PWSH)).toBe(true)
  })
})

describe('getWindowsPowerShellHost', () => {
  // Why it must not probe: this is the path the console builder takes, and it
  // runs on the main process.
  it('answers with Windows PowerShell until a warm-up resolves something better', async () => {
    expect(getWindowsPowerShellHost(ENV)).toBe(SYSTEM32_POWERSHELL)
    await warmWindowsPowerShellHostCache(
      async (candidate) => (candidate === WINDOWS_APPS_PWSH ? found() : missed()),
      ENV
    )
    expect(getWindowsPowerShellHost(ENV)).toBe(WINDOWS_APPS_PWSH)
  })
})

describe('warmWindowsPowerShellHostCache', () => {
  it('prefers PowerShell 7 even when Windows PowerShell happens to pass', async () => {
    const probe = vi.fn(found)
    expect(await warmWindowsPowerShellHostCache(probe, ENV)).toBe(PROGRAM_FILES_PWSH)
    expect(probe).not.toHaveBeenCalledWith(SYSTEM32_POWERSHELL)
  })

  // Why this is the whole point: on a locked-down fleet powershell.exe exists and
  // exits 0 without finishing the script, so only a probe that checks the script's
  // effect can reject it in favour of the PowerShell 7 that actually works.
  it('falls through to PowerShell 7 when Windows PowerShell exits without doing the work', async () => {
    const probe = vi.fn((candidate: string) =>
      candidate === PROGRAM_FILES_PWSH ? found() : missed()
    )
    expect(await warmWindowsPowerShellHostCache(probe, ENV)).toBe(PROGRAM_FILES_PWSH)
    expect(probe).not.toHaveBeenCalledWith(SYSTEM32_POWERSHELL)
  })

  // The probe spawns the host directly, so a `&` in the path passes it — but the
  // sign-in goes through `wrapWindowsStartWait`, whose cmd.exe guard refuses that
  // same path. Caching it would break every login on a machine whose System32
  // host worked, so the candidate must lose before it is ever probed.
  it('skips a candidate the start /wait wrapper could not launch', async () => {
    const unsafeEnv = { ...ENV, ProgramFiles: 'C:\\Tools & Utils', PATH: '' }
    const unsafePwsh = 'C:\\Tools & Utils\\PowerShell\\7\\pwsh.exe'
    const probe = vi.fn(found)

    expect(await warmWindowsPowerShellHostCache(probe, unsafeEnv)).toBe(WINDOWS_APPS_PWSH)
    expect(probe).not.toHaveBeenCalledWith(unsafePwsh)
  })

  it('reports an unlaunchable candidate as its own outcome, not as a probe failure', async () => {
    const unsafeEnv = {
      ...ENV,
      ProgramFiles: 'C:\\Tools & Utils',
      LOCALAPPDATA: 'C:\\Users\\a%b\\AppData\\Local',
      PATH: ''
    }
    const resolutions: WindowsPowerShellHostResolution[] = []
    setWindowsPowerShellHostResolutionObserver((resolution) => resolutions.push(resolution))

    // Why System32 must miss: otherwise it passes on its own merits and the
    // fallback this asserts is never taken.
    expect(await warmWindowsPowerShellHostCache(missed, unsafeEnv)).toBe(SYSTEM32_POWERSHELL)
    expect(resolutions[0]?.fellBack).toBe(true)
    expect(resolutions[0]?.attempts.map((attempt) => attempt.unwrappable ?? false)).toEqual([
      true,
      true,
      false
    ])
  })

  it('deduplicates quoted Windows PATH entries regardless of case or test host platform', () => {
    const candidates = getWindowsPowerShellHostCandidates({
      ...ENV,
      PATH: '"C:\\Program Files\\PowerShell\\7";c:\\program files\\powershell\\7;C:\\Tools'
    })
    expect(candidates).toEqual([
      PROGRAM_FILES_PWSH,
      WINDOWS_APPS_PWSH,
      'C:\\Tools\\pwsh.exe',
      SYSTEM32_POWERSHELL
    ])
  })

  it('uses Windows PowerShell when none of the PowerShell 7 hosts works', async () => {
    const probe = vi.fn((candidate: string) =>
      candidate === SYSTEM32_POWERSHELL ? found() : missed()
    )
    expect(await warmWindowsPowerShellHostCache(probe, ENV)).toBe(SYSTEM32_POWERSHELL)
    expect(probe.mock.calls.at(-1)).toEqual([SYSTEM32_POWERSHELL])
  })

  it('shares the pending probe between startup and simultaneous login requests', async () => {
    let finish!: (result: { ok: boolean }) => void
    const probe = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve
        })
    )
    const startup = warmWindowsPowerShellHostCache(probe, ENV)
    const login = warmWindowsPowerShellHostCache(probe, ENV)
    expect(startup).toBe(login)
    expect(probe).toHaveBeenCalledTimes(1)
    finish({ ok: true })
    await expect(login).resolves.toBe(PROGRAM_FILES_PWSH)
  })

  it('probes an execution alias instead of skipping it as missing', async () => {
    statSyncMock.mockImplementation((path: unknown) =>
      path === WINDOWS_APPS_PWSH ? throwFsError('EACCES') : throwFsError('ENOENT')
    )
    const probe = vi.fn((candidate: string) =>
      candidate === WINDOWS_APPS_PWSH ? found() : missed()
    )
    expect(await warmWindowsPowerShellHostCache(probe, ENV)).toBe(WINDOWS_APPS_PWSH)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(WINDOWS_APPS_PWSH)
  })

  // Why not report nothing: a probe can fail for reasons unrelated to the host,
  // and every environment that worked before this resolver existed used this path.
  it('falls back to Windows PowerShell when no candidate answers the probe', async () => {
    expect(await warmWindowsPowerShellHostCache(missed, ENV)).toBe(SYSTEM32_POWERSHELL)
  })

  it('probes once for a working host', async () => {
    const probe = vi.fn(found)
    await warmWindowsPowerShellHostCache(probe, ENV)
    await warmWindowsPowerShellHostCache(probe, ENV)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('re-probes after a fallback expires so a later PowerShell 7 install is picked up', async () => {
    const probe: WindowsPowerShellHostAsyncProbe = vi.fn(missed)
    expect(await warmWindowsPowerShellHostCache(probe, ENV)).toBe(SYSTEM32_POWERSHELL)
    const probeCallsWhileCached = vi.mocked(probe).mock.calls.length
    await warmWindowsPowerShellHostCache(probe, ENV)
    expect(vi.mocked(probe)).toHaveBeenCalledTimes(probeCallsWhileCached)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 31_000)
      vi.mocked(probe).mockImplementation(async (candidate: string) =>
        candidate === WINDOWS_APPS_PWSH ? found() : missed()
      )
      expect(await warmWindowsPowerShellHostCache(probe, ENV)).toBe(WINDOWS_APPS_PWSH)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the chosen host and what each probed candidate did', async () => {
    const seen: WindowsPowerShellHostResolution[] = []
    setWindowsPowerShellHostResolutionObserver((resolution) => seen.push(resolution))
    await warmWindowsPowerShellHostCache(
      (candidate) => (candidate === WINDOWS_APPS_PWSH ? found() : missed()),
      ENV
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.host).toBe(WINDOWS_APPS_PWSH)
    expect(seen[0]?.fellBack).toBe(false)
    expect(seen[0]?.candidates).toEqual(getWindowsPowerShellHostCandidates(ENV))
    expect(seen[0]?.attempts.map((attempt) => attempt.path)).not.toContain(SYSTEM32_POWERSHELL)
  })

  it('reports the fallback as a fallback rather than a choice', async () => {
    const seen: WindowsPowerShellHostResolution[] = []
    setWindowsPowerShellHostResolutionObserver((resolution) => seen.push(resolution))
    await warmWindowsPowerShellHostCache(async () => ({ ok: false, timedOut: true }), ENV)
    expect(seen[0]?.fellBack).toBe(true)
    expect(seen[0]?.attempts.every((attempt) => attempt.timedOut)).toBe(true)
  })
})

describe('probeWindowsPowerShellHostAsync', () => {
  // Guards the removal of a no-op -ExecutionPolicy Bypass: the policy gates
  // script files, never an encoded payload, so it was pure EDR signal.
  it('encodes the payload without an execution-policy bypass', async () => {
    runProcessMock.mockResolvedValue({ code: 7, timedOut: false })

    await probeWindowsPowerShellHostAsync(PROGRAM_FILES_PWSH)

    const { program, args } = runProcessMock.mock.calls[0][0]
    expect(program).toBe(PROGRAM_FILES_PWSH)
    expect(args).not.toContain('-ExecutionPolicy')
    expect(args).not.toContain('Bypass')
    expect(args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand'
    ])
    expect(Buffer.from(args[4], 'base64').toString('utf16le')).toContain('exit 7')
  })

  it('rejects a host that reports the exit code without writing the marker', async () => {
    runProcessMock.mockResolvedValue({ code: 7, timedOut: false })

    await expect(probeWindowsPowerShellHostAsync(PROGRAM_FILES_PWSH)).resolves.toMatchObject({
      ok: false,
      markerOk: false
    })
  })

  // Why the positive control: without it the timeout case below could pass on a
  // helper that never writes the marker, asserting nothing about `timedOut`.
  it('accepts a host that writes the marker and reports the exit code in time', async () => {
    runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
      answerProbe(spec)
      return { code: 7, timedOut: false }
    })

    await expect(probeWindowsPowerShellHostAsync(PROGRAM_FILES_PWSH)).resolves.toMatchObject({
      ok: true,
      markerOk: true
    })
  })

  // The fleet laptop's 5.1 answered 13/15 trivial probes. `runProcess` kills on
  // timeout but still settles from close, so a late answer arrives with a real
  // exit code — caching it would reinstate the intermittent host.
  it('rejects a host that answered only after the probe budget expired', async () => {
    runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
      answerProbe(spec)
      return { code: 7, timedOut: true }
    })

    await expect(probeWindowsPowerShellHostAsync(PROGRAM_FILES_PWSH)).resolves.toMatchObject({
      ok: false,
      timedOut: true,
      exitCode: 7,
      markerOk: true
    })
  })
})
