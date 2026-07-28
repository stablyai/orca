import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createSequencedSetupAgentCommands,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV
} from './setup-agent-sequencing'

const TEMP_DIRS: string[] = []

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform !== 'win32')('Windows setup-agent sequencing', () => {
  it.each([
    'path with spaces',
    'ampersand&parentheses(test)',
    'caret^percent%bang!',
    "apostrophe's directory",
    'Unicode-한글-abc'
  ])('preserves the native runner path in %s', async (directoryName) => {
    const tempDir = makeTempDir(directoryName)
    const runnerScriptPath = join(tempDir, 'setup runner.cmd')
    const startupScriptPath = join(tempDir, 'agent startup.ps1')
    const logPath = join(dirname(tempDir), 'sequence.log')
    const prompt = 'spaces & pipe | caret ^ percent % bang ! "quotes" Unicode 한글 trailing\\'

    writeFileSync(
      runnerScriptPath,
      ['@echo off', `>> "${logPath}" echo setup-done`, 'exit /b 0'].join('\r\n'),
      'utf8'
    )
    writeFileSync(
      startupScriptPath,
      [
        'param([string]$Value)',
        '$utf8 = [System.Text.UTF8Encoding]::new($false)',
        `[System.IO.File]::AppendAllText('${quotePowerShell(logPath)}', $Value + [Environment]::NewLine, $utf8)`
      ].join('\r\n'),
      'utf8'
    )

    const commands = createSequencedSetupAgentCommands({
      runnerScriptPath,
      startupCommand: `& '${quotePowerShell(startupScriptPath)}' '${quotePowerShell(prompt)}'`,
      platform: 'windows',
      nonce: 'windows-sequence',
      waitTimeoutSeconds: 2
    })

    const setupExit = await waitForExit(
      spawnWindowsCommand(dirname(tempDir), 'run setup.cmd', commands.setupCommand)
    )
    expect(setupExit.code).toBe(0)
    expect(readFileSync(`${runnerScriptPath}.windows-sequence.done`, 'utf8')).toBe(
      'windows-sequence:0\r\n'
    )

    const startupExit = await waitForExit(
      spawnWindowsCommand(
        dirname(tempDir),
        'run startup.cmd',
        commands.startupCommand,
        commands.startupEnv
      )
    )
    expect(startupExit.code).toBe(0)
    expect(startupExit.stderr).toContain('Waiting for setup to finish before starting agent...')
    expect(readFileSync(logPath, 'utf8')).toBe(`setup-done\r\n${prompt}\r\n`)
  })

  it('keeps the startup command out of generated cmd.exe source', () => {
    const startupCommand = 'agent --prompt "& | ^ % ! 한글 trailing\\"'
    const commands = createSequencedSetupAgentCommands({
      runnerScriptPath: 'C:\\repo\\setup-runner.cmd',
      startupCommand,
      platform: 'windows',
      nonce: 'windows-sequence'
    })

    expect(commands.setupCommand).not.toContain(startupCommand)
    expect(commands.startupCommand).not.toContain(startupCommand)
    expect(commands.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]).toBe(startupCommand)
  })

  it('propagates setup failure without launching the agent', async () => {
    const tempDir = makeTempDir('failure path & metacharacters!')
    const runnerScriptPath = join(tempDir, 'setup runner.cmd')
    const startupScriptPath = join(tempDir, 'agent startup.cmd')
    const startupLogPath = join(dirname(tempDir), 'agent-started.log')

    writeFileSync(runnerScriptPath, '@echo off\r\nexit /b 37\r\n', 'utf8')
    writeFileSync(
      startupScriptPath,
      `@echo off\r\necho started>"${startupLogPath}"\r\nexit /b 0\r\n`,
      'utf8'
    )
    const commands = createSequencedSetupAgentCommands({
      runnerScriptPath,
      startupCommand: `cmd.exe /d /c "${startupScriptPath}"`,
      platform: 'windows',
      nonce: 'failed-windows-sequence',
      waitTimeoutSeconds: 2
    })

    const setupExit = await waitForExit(
      spawnWindowsCommand(dirname(tempDir), 'run failed setup.cmd', commands.setupCommand)
    )
    expect(setupExit.code).toBe(37)
    expect(readFileSync(`${runnerScriptPath}.failed-windows-sequence.done`, 'utf8')).toBe(
      'failed-windows-sequence:37\r\n'
    )

    const startupExit = await waitForExit(
      spawnWindowsCommand(
        dirname(tempDir),
        'run blocked startup.cmd',
        commands.startupCommand,
        commands.startupEnv
      )
    )
    expect(startupExit.code).toBe(37)
    expect(startupExit.stderr).toContain('Setup failed; skipping agent startup.')
    expect(existsSync(startupLogPath)).toBe(false)
  })
})

function makeTempDir(directoryName: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-setup-sequencing-'))
  TEMP_DIRS.push(root)
  const dir = join(root, directoryName)
  mkdirSync(dir)
  return dir
}

function spawnWindowsCommand(
  dir: string,
  filename: string,
  command: string,
  env: Record<string, string> = {}
): ReturnType<typeof spawn> {
  const scriptPath = join(dir, filename)
  writeFileSync(scriptPath, `@echo off\r\n${command}\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8')
  return spawn('cmd.exe', ['/d', '/c', scriptPath], {
    stdio: 'pipe',
    env: { ...process.env, ...env }
  })
}

function quotePowerShell(value: string): string {
  return value.replace(/'/g, "''")
}

function waitForExit(
  child: ReturnType<typeof spawn>
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      resolve({ code, stderr })
    })
  })
}
