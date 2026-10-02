import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from './child-process/run-process'
import {
  LAUNCH_FILE_STALE_MS,
  LaunchFileUnavailableError,
  launchFilePathInQuotedRun,
  removeLaunchFile,
  sweepStaleLaunchFiles,
  writeLaunchFile
} from './launch-file-writing'
import { buildLaunchFilePointer, carryInLaunchFile, parseLaunchFile } from './launch-prompt-file'
import { quoteStartupArg } from './tui-agent-startup-shell'

let baseDirectory: string

beforeEach(() => {
  baseDirectory = mkdtempSync(join(tmpdir(), 'orca-launchfile-test-'))
})

afterEach(() => {
  rmSync(baseDirectory, { recursive: true, force: true })
})

describe('carryInLaunchFile', () => {
  it('moves a prompt into a launch file and names it by a pointer', () => {
    const prompt = 'b'.repeat(20_000)
    const carried = carryInLaunchFile(prompt)
    expect(carried.launchFile).toMatchObject({ content: prompt })
    expect(carried.prompt).toBe(buildLaunchFilePointer(carried.launchFile.placeholder))
  })

  it('keeps the prompt off the pointer', () => {
    const carried = carryInLaunchFile('fix the flaky test')
    expect(carried.prompt).not.toContain('flaky')
  })

  it('mints a fresh placeholder each time', () => {
    const first = carryInLaunchFile('x').launchFile.placeholder
    const second = carryInLaunchFile('x').launchFile.placeholder
    expect(first).not.toBe(second)
  })
})

describe('parseLaunchFile', () => {
  it('accepts what carryInLaunchFile mints and rejects anything else', () => {
    const { launchFile } = carryInLaunchFile('x')
    expect(parseLaunchFile(launchFile)).toEqual(launchFile)
    expect(parseLaunchFile({ ...launchFile, placeholder: 'HOME' })).toBeUndefined()
    expect(parseLaunchFile({ ...launchFile, content: 7 })).toBeUndefined()
    expect(parseLaunchFile({ ...launchFile, quoting: 'cmd' })).toEqual({
      ...launchFile,
      quoting: 'cmd'
    })
    expect(parseLaunchFile({ ...launchFile, quoting: 'fish' })).toBeUndefined()
    expect(parseLaunchFile(null)).toBeUndefined()
  })
})

describe('writeLaunchFile', () => {
  it('writes a 0600 file in a private 0700 directory and puts its path in the line and env', () => {
    const { prompt, launchFile } = carryInLaunchFile('c'.repeat(20_000))
    const written = writeLaunchFile({
      launchFile: launchFile!,
      command: `claude '${prompt}'`,
      env: { ORCA_HERMES_STARTUP_QUERY: prompt, OTHER: 'kept' },
      baseDirectory
    })
    expect(dirname(written.path)).toBe(written.directory)
    expect(statSync(written.directory).mode & 0o777).toBe(0o700)
    expect(statSync(written.path).mode & 0o777).toBe(0o600)
    expect(readFileSync(written.path, 'utf8')).toBe('c'.repeat(20_000))
    expect(written.command).toBe(`claude '${buildLaunchFilePointer(written.path)}'`)
    expect(written.env).toEqual({
      ORCA_HERMES_STARTUP_QUERY: buildLaunchFilePointer(written.path),
      OTHER: 'kept'
    })
  })

  it("refuses an apostrophe in the path when the line's quoting is unknown, leaving nothing behind", () => {
    const quoted = join(baseDirectory, "it's")
    mkdirSync(quoted)
    const { launchFile } = carryInLaunchFile('x')
    expect(() => writeLaunchFile({ launchFile: launchFile!, baseDirectory: quoted })).toThrow(
      LaunchFileUnavailableError
    )
    expect(readdirSync(quoted)).toEqual([])
  })

  it('refuses when the temp directory cannot be written', () => {
    const { launchFile } = carryInLaunchFile('x')
    expect(() =>
      writeLaunchFile({ launchFile: launchFile!, baseDirectory: join(baseDirectory, 'missing') })
    ).toThrow(
      /^Orca could not write the file that carries the agent's prompt \(.+\), so the agent was not started\./
    )
  })

  it('removes the whole directory', () => {
    const { launchFile } = carryInLaunchFile('x')
    const written = writeLaunchFile({ launchFile: launchFile!, baseDirectory })
    removeLaunchFile(written)
    expect(existsSync(written.directory)).toBe(false)
  })
})

describe('launchFilePathInQuotedRun', () => {
  const temp = (user: string): string =>
    `C:\\Users\\${user}\\AppData\\Local\\Temp\\orca-launch-file-a1\\task-context.md`

  it('carries letters of any script as they are, whatever the quoting', () => {
    for (const path of [temp('José'), temp('张伟')]) {
      expect(launchFilePathInQuotedRun(path, 'cmd', 'win32')).toBe(path)
      expect(launchFilePathInQuotedRun(path, 'powershell', 'win32')).toBe(path)
      expect(launchFilePathInQuotedRun(path, undefined, 'win32')).toBe(path)
    }
  })

  it('writes an apostrophe the way each quoting reads it, and refuses it unquoted', () => {
    const path = temp("O'Brien")
    expect(launchFilePathInQuotedRun(path, 'cmd', 'win32')).toBe(path)
    expect(launchFilePathInQuotedRun(path, 'powershell', 'win32')).toBe(temp("O''Brien"))
    expect(launchFilePathInQuotedRun("/home/O'Brien/x", 'posix', 'linux')).toBe(
      `/home/O'"'"'Brien/x`
    )
    expect(launchFilePathInQuotedRun(path, undefined, 'win32')).toBeNull()
  })

  it("breaks `%` out of cmd's quoted run, where cmd would expand it", () => {
    expect(launchFilePathInQuotedRun(temp('100%'), 'cmd', 'win32')).toBe(temp('100"^%"'))
    expect(launchFilePathInQuotedRun(temp('100%'), 'powershell', 'win32')).toBe(temp('100%'))
    expect(launchFilePathInQuotedRun(temp('100%'), undefined, 'win32')).toBeNull()
  })

  it('refuses a control character in any quoting', () => {
    for (const quoting of ['posix', 'cmd', 'powershell', undefined] as const) {
      expect(launchFilePathInQuotedRun('/tmp/a\nb/x', quoting, 'linux')).toBeNull()
    }
  })
})

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('a launch line naming a file under an unusual home directory', () => {
  const shells = [
    ['/bin/sh', '-c'],
    ['/bin/bash', '-c'],
    ['/bin/zsh', '-f', '-c'],
    ['/bin/dash', '-c'],
    ['/opt/homebrew/bin/fish', '--no-config', '-c'],
    ['/usr/bin/fish', '--no-config', '-c']
  ].filter(([shell]) => existsSync(shell))

  it.each(["O'Brien", 'José', '张伟', 'back\\slash', "it's $'x' 100%"])(
    'reaches the agent as the exact path under %s',
    async (user) => {
      const home = join(baseDirectory, user)
      mkdirSync(home)
      const { prompt, launchFile } = carryInLaunchFile('brief')
      const written = writeLaunchFile({
        launchFile: { ...launchFile!, quoting: 'posix' },
        command: `printf '%s' ${quoteStartupArg(prompt, 'posix')}`,
        baseDirectory: home
      })
      for (const [shell, ...flags] of shells) {
        const result = await runProcess({
          program: shell,
          args: [...flags, written.command!],
          timeoutMs: 10_000
        })
        expect(result.stdout, shell).toBe(buildLaunchFilePointer(written.path))
      }
    }
  )
})

describe('sweepStaleLaunchFiles', () => {
  const ageOut = (directory: string, now: number): void => {
    const staleSeconds = (now - LAUNCH_FILE_STALE_MS - 1000) / 1000
    utimesSync(directory, staleSeconds, staleSeconds)
  }

  // Why: a daemon session outlives app restarts; its agent may re-read its task file any time.
  it('never removes a folder whose owning process is alive, however old', () => {
    const now = Date.now()
    const live = join(baseDirectory, `orca-launch-file-${process.pid}-aaaaaa`)
    mkdirSync(live)
    ageOut(live, now)
    sweepStaleLaunchFiles({ baseDirectory, now })
    expect(readdirSync(baseDirectory)).toEqual([`orca-launch-file-${process.pid}-aaaaaa`])
  })

  it('removes a folder whose owning process is gone, however new', () => {
    const deadPid = 2_147_483_000
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      }
      return true
    })
    try {
      mkdirSync(join(baseDirectory, `orca-launch-file-${deadPid}-bbbbbb`))
      sweepStaleLaunchFiles({ baseDirectory })
      expect(readdirSync(baseDirectory)).toEqual([])
    } finally {
      kill.mockRestore()
    }
  })

  it('falls back to the age backstop for a folder that names no owner', () => {
    const now = Date.now()
    const stale = join(baseDirectory, 'orca-launch-file-aaaaaa')
    const fresh = join(baseDirectory, 'orca-launch-file-bbbbbb')
    const unrelated = join(baseDirectory, 'unrelated')
    for (const directory of [stale, fresh, unrelated]) {
      mkdirSync(directory)
    }
    ageOut(stale, now)
    ageOut(unrelated, now)
    sweepStaleLaunchFiles({ baseDirectory, now })
    expect(readdirSync(baseDirectory).sort()).toEqual(['orca-launch-file-bbbbbb', 'unrelated'])
  })

  it('names the owning process in each folder it writes', () => {
    const { launchFile } = carryInLaunchFile('x')
    const written = writeLaunchFile({
      launchFile: { ...launchFile, quoting: 'posix' },
      baseDirectory
    })
    expect(written.directory).toMatch(new RegExp(`orca-launch-file-${process.pid}-[^/\\\\]+$`))
    removeLaunchFile(written)
  })
})
