import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LaunchFileUnavailableError, writeSpawnLaunchFile } from './launch-file-writing'
import { buildLaunchFilePointer, carryInLaunchFile, type LaunchFile } from './launch-prompt-file'
import { stageStartupCommand } from './startup-command-staging'
import { parseWslLaunchDirectory, type WslLaunchDirectory } from './wsl-launch-directory'

let windowsSide: string
let directory: WslLaunchDirectory

beforeEach(() => {
  // Stands in for `\\wsl.localhost\Ubuntu\home\ada\.cache\orca`, which only Windows can open.
  windowsSide = join(mkdtempSync(join(tmpdir(), 'orca-wsl-dir-test-')), 'cache')
  directory = { distro: 'Ubuntu', windowsPath: windowsSide, linuxPath: '/home/ada/.cache/orca' }
})

afterEach(() => {
  rmSync(join(windowsSide, '..'), { recursive: true, force: true })
})

function launchFile(content = 'fix the build'): LaunchFile {
  const planned = carryInLaunchFile(content)
  return { ...planned.launchFile!, quoting: 'posix' }
}

describe('a WSL launch file', () => {
  it('is written through the Windows side and named by its Linux path in the line', () => {
    const file = launchFile()
    const written = writeSpawnLaunchFile({
      launchFile: file,
      command: `claude '${buildLaunchFilePointer(file.placeholder)}'`,
      wslDistro: 'Ubuntu',
      wslDirectory: directory
    })!
    const [created] = readdirSync(windowsSide)
    expect(written.directory).toBe(join(windowsSide, created!))
    expect(readFileSync(join(written.directory, 'task-context.md'), 'utf8')).toBe('fix the build')
    expect(written.path).toBe(`/home/ada/.cache/orca/${created}/task-context.md`)
    expect(written.command).toContain(written.path)
    expect(written.command).not.toContain(windowsSide)
  })

  it("refuses rather than name a Windows path the distro's agent cannot read", () => {
    const write = (wslDirectory: WslLaunchDirectory | undefined) =>
      writeSpawnLaunchFile({
        launchFile: launchFile(),
        command: 'claude',
        wslDistro: 'Ubuntu',
        wslDirectory
      })
    expect(() => write(undefined)).toThrow(LaunchFileUnavailableError)
    expect(() => write({ ...directory, distro: 'Debian' })).toThrow(LaunchFileUnavailableError)
    expect(readdirSync(join(windowsSide, '..'))).toEqual([])
  })

  // Why: the plan read the same probe, so with no folder it chose main's delivery, typed as is.
  it('leaves a line of any length to be typed when the distro has no folder', () => {
    for (const command of [`claude '${'x'.repeat(600)}'`, `claude 'one\ntwo'`, `claude 'fix it'`]) {
      expect(
        writeSpawnLaunchFile({ command, wslDistro: 'Ubuntu', wslDirectory: undefined })
      ).toBeUndefined()
    }
  })
})

describe('a WSL staged line', () => {
  it('writes the script through the Windows side and runs it by its Linux path', () => {
    const command = `claude '${'x'.repeat(600)}'`
    const staging = stageStartupCommand({
      command,
      shellPath: 'C:\\Windows\\System32\\wsl.exe',
      orcaBuiltLine: true,
      platform: 'win32',
      wslDirectory: directory
    })
    const [script] = readdirSync(windowsSide)
    expect(staging).toMatchObject({ delivery: 'staged', scriptPath: join(windowsSide, script!) })
    // With no login shell from the probe, `/bin/sh` runs it whatever that shell is.
    expect(staging.command).toBe(`/bin/sh '/home/ada/.cache/orca/${script}'`)
    expect(readFileSync(join(windowsSide, script!), 'utf8')).toBe(
      `command rm -f -- '/home/ada/.cache/orca/${script}'\n${command}\n`
    )
  })

  // Why: /bin/sh would skip the pane's own functions, such as Orca's codex wrapper.
  it.each([
    ['/bin/bash', (path: string) => `. ${path}`],
    ['/usr/bin/zsh', (path: string) => `. ${path}`],
    ['/usr/bin/fish', (path: string) => `eval (string collect < ${path})`],
    // ksh would run a sourced file in its own process group, so Ctrl-Z could not stop the agent.
    ['/bin/ksh', (path: string) => `/bin/sh ${path}`]
  ])('runs the script for the distro login shell %s', (shell, line) => {
    const staging = stageStartupCommand({
      command: `codex '${'x'.repeat(600)}'`,
      shellPath: 'C:\\Windows\\System32\\wsl.exe',
      orcaBuiltLine: true,
      platform: 'win32',
      wslDirectory: { ...directory, shell }
    })
    const [script] = readdirSync(windowsSide)
    expect(staging.command).toBe(line(`'/home/ada/.cache/orca/${script}'`))
  })

  it("types a short line as is once the distro's shell is one Orca's quoting is literal in", () => {
    const staging = stageStartupCommand({
      command: `claude 'fix it'`,
      shellPath: 'C:\\Windows\\System32\\wsl.exe',
      orcaBuiltLine: true,
      platform: 'win32',
      wslDirectory: { ...directory, shell: '/bin/bash' }
    })
    expect(staging).toEqual({ command: `claude 'fix it'`, delivery: 'typed' })
  })
})

describe('parseWslLaunchDirectory', () => {
  it('accepts a UNC and Linux pair and rejects anything else', () => {
    const valid = {
      distro: 'Ubuntu',
      windowsPath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cache\\orca',
      linuxPath: '/home/ada/.cache/orca'
    }
    expect(parseWslLaunchDirectory(valid)).toEqual(valid)
    expect(parseWslLaunchDirectory({ ...valid, windowsPath: 'C:\\Users\\ada' })).toBeUndefined()
    expect(parseWslLaunchDirectory({ ...valid, linuxPath: 'home/ada' })).toBeUndefined()
    expect(parseWslLaunchDirectory({ distro: 'Ubuntu' })).toBeUndefined()
    expect(parseWslLaunchDirectory(null)).toBeUndefined()
  })

  it("keeps the distro's login shell only when it is an absolute path", () => {
    const valid = {
      distro: 'Ubuntu',
      windowsPath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cache\\orca',
      linuxPath: '/home/ada/.cache/orca'
    }
    expect(parseWslLaunchDirectory({ ...valid, shell: '/bin/bash' })).toEqual({
      ...valid,
      shell: '/bin/bash'
    })
    expect(parseWslLaunchDirectory({ ...valid, shell: 'bash' })).toEqual(valid)
    expect(parseWslLaunchDirectory({ ...valid, shell: 7 })).toEqual(valid)
  })
})
