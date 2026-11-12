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
    // CR-cmd-quiet: a leading space, so HISTCONTROL=ignorespace shells skip it too.
    expect(staged.command).toBe(` . '${staged.scriptPath}'`)
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

describe('CR-cmd-quiet: Orca’s staged agent line leaves no trace on a cloud host', () => {
  const ESC = '\u001b'

  function quietStage(shellPath: string, command: string) {
    return stageStartupCommand({
      command,
      shellPath,
      platform: 'linux',
      directory,
      orcaBuiltLine: true,
      cloudHost: true
    })
  }

  it('erases the echoed prompt and line, then runs the agent; its errors still print', () => {
    const staged = quietStage('/bin/bash', 'echo AGENT-OUTPUT; ls /orca-no-such-dir')
    // A 21-column prompt plus the typed line on a 40-column terminal: the rows they took.
    const prompt = 'user@host:~/project$ '
    const rows = Math.ceil((prompt.length + staged.command.length) / 40)
    let stdout = ''
    let stderr = ''
    try {
      execFileSync('bash', ['-c', `PS1='${prompt}'; ${staged.command}`], {
        env: { ...process.env, COLUMNS: '40' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      const failed = error as { stdout: string; stderr: string }
      stdout = failed.stdout
      stderr = failed.stderr
    }
    expect(stdout.startsWith(`\r${ESC}[${rows}A${ESC}[J`)).toBe(true)
    expect(stdout).toContain('AGENT-OUTPUT')
    expect(stderr).toContain('orca-no-such-dir')
  })

  it('drops the line from bash history', () => {
    const staged = quietStage('/bin/bash', 'true')
    const history = execFileSync(
      'bash',
      [
        '-c',
        `set -o history; history -s 'echo before'; history -s ${JSON.stringify(staged.command)}; ${staged.command}; history`
      ],
      { encoding: 'utf8' }
    )
    expect(history).toContain('echo before')
    expect(history).not.toContain('orca-launch-')
  })

  it('leaves history alone when the line was never recorded (ignorespace)', () => {
    const staged = quietStage('/bin/bash', 'true')
    const history = execFileSync(
      'bash',
      ['-c', `set -o history; history -s 'echo before'; ${staged.command}; history`],
      { encoding: 'utf8' }
    )
    expect(history).toContain('echo before')
  })

  it('runs under zsh too', () => {
    const staged = quietStage('/bin/zsh', 'echo AGENT-OUTPUT')
    let out = ''
    try {
      out = execFileSync('zsh', ['-f', '-c', `PS1='%n %# '; ${staged.command}`], {
        env: { ...process.env, COLUMNS: '80' },
        encoding: 'utf8'
      })
    } catch {
      // No zsh on this machine: nothing to check.
      return
    }
    expect(out).toMatch(new RegExp(`^\\r${ESC}\\[\\d+A${ESC}\\[J`))
    expect(out).toContain('AGENT-OUTPUT')
  })

  it('plain shells and anything the user typed are unchanged', () => {
    expect(
      stageStartupCommand({
        command: 'npm test',
        shellPath: '/bin/bash',
        platform: 'linux',
        directory,
        cloudHost: true
      })
    ).toEqual({ command: 'npm test', delivery: 'typed' })
    // An Orca line in a shell the prelude doesn't know stays as #431 staged it.
    const sh = quietStage('/bin/sh', 'true')
    expect(sh.command.startsWith('. ')).toBe(true)
    expect(readFileSync(sh.scriptPath!, 'utf8')).not.toContain('__orca_q_')
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
