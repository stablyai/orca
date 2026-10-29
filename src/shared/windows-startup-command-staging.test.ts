import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discardStagedStartupCommand,
  sweepStaleStagedStartupCommands
} from './startup-command-staging'
import { stageWindowsStartupCommand } from './windows-startup-command-staging'

const directories: string[] = []

function newDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-win-staging-test-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('stageWindowsStartupCommand', () => {
  it('keeps cmd script lines together and invokes the batch file once', async () => {
    const directory = newDirectory()
    const staged = await stageWindowsStartupCommand({
      command: 'set /p answer=Answer?\r\necho %answer%',
      shellPath: 'cmd.exe',
      directory
    })
    expect(staged.delivery).toBe('staged')
    expect(staged.command).toMatch(/^call ".*\.cmd"$/)
    expect(readFileSync(staged.scriptPath!, 'utf8')).toContain(
      'set /p answer=Answer?\r\necho %answer%'
    )
    discardStagedStartupCommand(staged)
    expect(readdirSync(directory)).toEqual([])
  })

  it('writes a UTF-8 BOM for Windows PowerShell and retains multiline syntax', async () => {
    const staged = await stageWindowsStartupCommand({
      command: '$answer = Read-Host "名字"\nWrite-Output $answer',
      shellPath: 'powershell.exe',
      directory: newDirectory()
    })
    expect(staged.command).toMatch(/^& '.*\.ps1'$/)
    expect(readFileSync(staged.scriptPath!, 'utf8')).toContain('名字"\nWrite-Output')
    expect(readFileSync(staged.scriptPath!, 'utf8').startsWith('\uFEFF')).toBe(true)
  })

  it('uses shell-visible paths for Git Bash and WSL', async () => {
    const directory = newDirectory()
    const bash = await stageWindowsStartupCommand({
      command: 'read answer\necho "$answer"',
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      directory
    })
    expect(bash.command).toMatch(/^sh '\/[a-z]\/.*orca-launch-.*\.sh'$/)
    const wsl = await stageWindowsStartupCommand({
      command: 'read answer\necho "$answer"',
      shellPath: 'wsl.exe',
      directory
    })
    expect(wsl.command).toMatch(/^sh '\/mnt\/[a-z]\/.*orca-launch-.*\.sh'$/)
    discardStagedStartupCommand(bash)
    discardStagedStartupCommand(wsl)
  })

  it('refuses an inaccessible WSL path without writing a file', async () => {
    const directory = newDirectory()
    const staged = await stageWindowsStartupCommand({
      command: 'echo first\necho second',
      shellPath: 'wsl.exe',
      directory: '\\\\server\\share'
    })
    expect(staged.failure).toContain('not accessible')
    expect(readdirSync(directory)).toEqual([])
  })

  it('reports a staging write failure without returning a runnable command', async () => {
    const staged = await stageWindowsStartupCommand({
      command: 'echo first\necho second',
      shellPath: 'cmd.exe',
      directory: join(newDirectory(), 'missing')
    })
    expect(staged.delivery).toBe('typed-after-stage-failed')
    expect(staged.failure).toMatch(/ENOENT/)
    expect(staged.scriptPath).toBeUndefined()
  })

  it('cleans stale Windows scripts using the existing sweep', async () => {
    const directory = newDirectory()
    const staged = await stageWindowsStartupCommand({
      command: 'echo first\necho second',
      shellPath: 'cmd.exe',
      directory
    })
    sweepStaleStagedStartupCommands({ directory, now: Date.now() + 2 * 60 * 60 * 1000 })
    expect(readdirSync(directory)).toEqual([])
    expect(staged.scriptPath).toBeDefined()
  })
})
