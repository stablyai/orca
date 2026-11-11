import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STAGED_STARTUP_COMMAND_STALE_MS,
  discardStagedStartupCommand,
  stageStartupCommand,
  sweepStaleStagedStartupCommands
} from './startup-command-staging'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-staging-test-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function stage(command: string, shellPath = '/bin/zsh', platform: NodeJS.Platform = 'darwin') {
  return stageStartupCommand({ command, shellPath, platform, directory })
}

describe('stageStartupCommand', () => {
  it('writes a 0600 script whose body is exactly the command, and types a sourcing line', () => {
    const command = `claude '${'x'.repeat(600)}'`
    const staged = stage(`${command}\n`)
    expect(staged.delivery).toBe('staged')
    expect(staged.scriptPath).toBeDefined()
    const scriptPath = staged.scriptPath!
    expect(staged.command).toBe(`. '${scriptPath}'`)
    expect(statSync(scriptPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(scriptPath, 'utf8')).toBe(`command rm -f -- '${scriptPath}'\n${command}\n`)
  })

  it('types the full command and says so when the script cannot be written', () => {
    const command = 'a'.repeat(600)
    const staged = stageStartupCommand({
      command,
      shellPath: '/bin/bash',
      platform: 'linux',
      directory: join(directory, 'missing')
    })
    expect(staged.command).toBe(command)
    expect(staged.delivery).toBe('typed-after-stage-failed')
    expect(staged.failure).toMatch(/ENOENT/)
    expect(staged.scriptPath).toBeUndefined()
  })
})

describe('stageStartupCommand on an Orca Cloud host (CR-cmd)', () => {
  const agentLine =
    "claude --plugin-dir '/vercel/.orcad-data/agent-view' '--dangerously-skip-permissions' 'fix the typo'"

  it('stages even a short Orca-built agent line, so the pane shows no flags or prompt', () => {
    const staged = stageStartupCommand({
      command: agentLine,
      shellPath: '/bin/bash',
      platform: 'linux',
      directory,
      orcaBuiltLine: true,
      cloudHost: true
    })
    expect(staged.delivery).toBe('staged')
    expect(staged.command).toBe(`. '${staged.scriptPath}'`)
    expect(staged.command).not.toContain('dangerously')
    expect(readFileSync(staged.scriptPath!, 'utf8')).toContain(agentLine)
  })

  it('the staged script is owner-only and removes itself when the shell runs it, before the agent starts', () => {
    const marker = join(directory, 'agent-ran')
    const staged = stageStartupCommand({
      // Stands in for the agent launch.
      command: `touch '${marker}'`,
      shellPath: '/bin/sh',
      platform: 'linux',
      directory,
      orcaBuiltLine: true,
      cloudHost: true
    })
    const scriptPath = staged.scriptPath!
    expect(basename(scriptPath)).toMatch(/^orca-launch-[0-9a-f]{16}\.sh$/)
    expect(statSync(scriptPath).mode & 0o777).toBe(0o600)
    execFileSync('/bin/sh', ['-c', staged.command])
    expect(existsSync(scriptPath)).toBe(false)
    expect(existsSync(marker)).toBe(true)
  })

  it('local launches are unchanged: a short agent line is still typed', () => {
    const staged = stageStartupCommand({
      command: agentLine,
      shellPath: '/bin/zsh',
      platform: 'darwin',
      directory,
      orcaBuiltLine: true,
      cloudHost: false
    })
    expect(staged).toEqual({ command: agentLine, delivery: 'typed' })
  })

  it('a user-typed command on a cloud host is still typed as written', () => {
    const staged = stageStartupCommand({
      command: 'npm test',
      shellPath: '/bin/bash',
      platform: 'linux',
      directory,
      cloudHost: true
    })
    expect(staged).toEqual({ command: 'npm test', delivery: 'typed' })
  })
})

describe('discardStagedStartupCommand', () => {
  it('removes a script the shell never sourced', () => {
    const staged = stage('a'.repeat(600))
    discardStagedStartupCommand(staged)
    expect(readdirSync(directory)).toEqual([])
  })
})

describe('sweepStaleStagedStartupCommands', () => {
  it('removes only staged scripts older than an hour', () => {
    const now = Date.now()
    const stale = join(directory, 'orca-launch-aaaa.sh')
    const fresh = join(directory, 'orca-launch-bbbb.sh')
    const unrelated = join(directory, 'something-else.sh')
    for (const path of [stale, fresh, unrelated]) {
      writeFileSync(path, '')
    }
    const staleSeconds = (now - STAGED_STARTUP_COMMAND_STALE_MS - 1000) / 1000
    utimesSync(stale, staleSeconds, staleSeconds)
    utimesSync(unrelated, staleSeconds, staleSeconds)
    sweepStaleStagedStartupCommands({ directory, now })
    expect(readdirSync(directory).sort()).toEqual(['orca-launch-bbbb.sh', 'something-else.sh'])
  })
})
