import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planLaunchForTest } from './launch-prompt-plan.test-fixture'
import { writeLaunchFile } from './launch-file-writing'
import {
  buildLaunchFilePointer,
  carryInLaunchFile,
  launchFileDirectoryPlaceholder
} from './launch-prompt-file'
import type { TuiAgent } from './tui-agent'

function planWithLaunchFile(agent: TuiAgent, shell: 'posix' | 'cmd' | 'powershell' = 'posix') {
  const { prompt, launchFile } = carryInLaunchFile('the brief')
  const plan = planLaunchForTest({
    agent,
    prompt,
    cmdOverrides: {},
    platform: shell === 'posix' ? 'darwin' : 'win32',
    shell,
    launchFile
  })
  return { plan, pointer: prompt, dir: launchFileDirectoryPlaceholder(launchFile.placeholder) }
}

describe('the launch-file directory grant on the agent command line', () => {
  // Claude 2.1.280 parses `--add-dir <directories...>` variadically: in `--add-dir <dir> '<prompt>'`
  // the prompt would become a second directory. Its parser keeps `--add-dir=<dir>` to one value.
  it('grants Claude the directory as one `--add-dir=` token, before its positional prompt', () => {
    const { plan, pointer, dir } = planWithLaunchFile('claude')
    expect(plan?.launchCommand).toBe(`claude '--add-dir=${dir}' '${pointer}'`)
  })

  it('grants nothing to an agent not measured reading its launch file', () => {
    const { plan, pointer } = planWithLaunchFile('gemini')
    expect(plan?.launchCommand).toBe(`gemini --prompt-interactive '${pointer}'`)
  })

  it.each([
    [
      'cmd',
      (dir: string, pointer: string) =>
        `claude "--add-dir=${dir}" "${pointer.replaceAll('"', '""')}"`
    ],
    ['powershell', (dir: string, pointer: string) => `claude '--add-dir=${dir}' '${pointer}'`]
  ] as const)('quotes the grant for %s like the prompt beside it', (shell, expected) => {
    const { plan, pointer, dir } = planWithLaunchFile('claude', shell)
    expect(plan?.launchCommand).toBe(expected(dir, pointer))
  })

  it('adds nothing for an agent that reads outside its workspace freely, or without a file', () => {
    const { plan, pointer } = planWithLaunchFile('codex')
    expect(plan?.launchCommand).toBe(`codex '${pointer}'`)
    expect(
      planLaunchForTest({
        agent: 'claude',
        prompt: 'fix it',
        cmdOverrides: {},
        platform: 'darwin'
      })?.launchCommand
    ).toBe(`claude 'fix it'`)
  })
})

describe('the host writing a launch file whose directory is granted', () => {
  let baseDirectory: string

  beforeEach(() => {
    baseDirectory = mkdtempSync(join(tmpdir(), 'orca-launch-grant-test-'))
  })

  afterEach(() => {
    rmSync(baseDirectory, { recursive: true, force: true })
  })

  it("names only the launch file's own private directory, never the shared temp root", () => {
    const { plan } = planWithLaunchFile('claude')
    const written = writeLaunchFile({
      launchFile: plan!.launchFile!,
      command: plan!.launchCommand,
      baseDirectory
    })
    expect(written.directory).not.toBe(baseDirectory)
    expect(written.directory).toBe(realpathSync(written.directory))
    expect(written.command).toBe(
      `claude '--add-dir=${written.directory}' '${buildLaunchFilePointer(written.path)}'`
    )
  })

  it('names the resolved directory when the temp root is reached through a symlink', () => {
    const real = join(baseDirectory, 'private-var')
    mkdirSync(real)
    const linked = join(baseDirectory, 'var')
    symlinkSync(real, linked)
    const { plan } = planWithLaunchFile('claude')
    const written = writeLaunchFile({
      launchFile: plan!.launchFile!,
      command: plan!.launchCommand,
      baseDirectory: linked
    })
    expect(written.directory.startsWith(realpathSync(real))).toBe(true)
    expect(written.command).toBe(
      `claude '--add-dir=${written.directory}' '${buildLaunchFilePointer(written.path)}'`
    )
  })
})
