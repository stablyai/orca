import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWindowsPowerShellHostCandidates,
  resetWindowsPowerShellHostCacheForTests,
  resolveWindowsPowerShellHost
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

beforeEach(() => {
  resetWindowsPowerShellHostCacheForTests()
})

describe('getWindowsPowerShellHostCandidates', () => {
  it('offers Windows PowerShell first, then every place PowerShell 7 installs', () => {
    const candidates = getWindowsPowerShellHostCandidates(ENV)
    expect(candidates[0]).toBe(SYSTEM32_POWERSHELL)
    expect(candidates).toContain(PROGRAM_FILES_PWSH)
    expect(candidates).toContain(WINDOWS_APPS_PWSH)
    expect(candidates).toContain('C:\\Tools\\pwsh.exe')
  })

  it('lists the WindowsApps alias once even though PATH also names it', () => {
    const candidates = getWindowsPowerShellHostCandidates(ENV)
    expect(candidates.filter((entry) => entry === WINDOWS_APPS_PWSH)).toHaveLength(1)
  })
})

describe('resolveWindowsPowerShellHost', () => {
  it('keeps Windows PowerShell when it can still run a script', () => {
    const probe = vi.fn().mockReturnValue(true)
    expect(resolveWindowsPowerShellHost(probe, ENV)).toBe(SYSTEM32_POWERSHELL)
  })

  // Why this is the whole point: on a locked-down fleet powershell.exe exists and
  // exits 0 without finishing the script, so only a probe that checks the script's
  // effect can reject it in favour of the PowerShell 7 that actually works.
  it('falls through to PowerShell 7 when Windows PowerShell exits without doing the work', () => {
    const probe = vi.fn((candidate: string) => candidate === PROGRAM_FILES_PWSH)
    expect(resolveWindowsPowerShellHost(probe, ENV)).toBe(PROGRAM_FILES_PWSH)
    expect(probe).toHaveBeenCalledWith(SYSTEM32_POWERSHELL)
  })

  // Why not report nothing: a probe can fail for reasons unrelated to the host,
  // and every environment that worked before this resolver existed used this path.
  it('falls back to Windows PowerShell when no candidate answers the probe', () => {
    expect(resolveWindowsPowerShellHost(() => false, ENV)).toBe(SYSTEM32_POWERSHELL)
  })

  it('probes once for a working host', () => {
    const probe = vi.fn().mockReturnValue(true)
    resolveWindowsPowerShellHost(probe, ENV)
    resolveWindowsPowerShellHost(probe, ENV)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('re-probes after a negative answer expires so a later PowerShell 7 install is picked up', () => {
    const probe = vi.fn().mockReturnValue(false)
    expect(resolveWindowsPowerShellHost(probe, ENV)).toBe(SYSTEM32_POWERSHELL)
    const probeCallsWhileCached = probe.mock.calls.length
    resolveWindowsPowerShellHost(probe, ENV)
    expect(probe).toHaveBeenCalledTimes(probeCallsWhileCached)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 31_000)
      probe.mockImplementation((candidate: string) => candidate === WINDOWS_APPS_PWSH)
      expect(resolveWindowsPowerShellHost(probe, ENV)).toBe(WINDOWS_APPS_PWSH)
    } finally {
      vi.useRealTimers()
    }
  })
})
