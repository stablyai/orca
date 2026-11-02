import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createSequencedSetupAgentCommands,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV,
  SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV,
  type SequencedSetupAgentCommands
} from './setup-agent-sequencing'

const TEMP_DIRS: string[] = []
const WINDOWS_PROCESS_TEST_TIMEOUT_MS = 30_000

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('createSequencedSetupAgentCommands', () => {
  it('keeps the POSIX terminal submission below the canonical input floor', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: `/repo/${'nested-worktree/'.repeat(100)}setup-runner.sh`,
      startupCommand: 'codex',
      platform: 'posix',
      nonce: 'long-path'
    })

    expect(Buffer.byteLength(result.setupCommand)).toBeLessThan(256)
    expect(result.setupCommand).not.toContain('nested-worktree')
    expect(result.setupEnv?.[SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV]).toContain('nested-worktree')
    expect(result.startupCommand.length).toBeLessThan(256)
    expect(result.startupCommand).not.toContain('nested-worktree')
    expect(result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      'nested-worktree'
    )
  })

  it('keeps remote POSIX runners in bash even from a Windows client', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: '/remote/repo/.git/worktrees/feature/orca/setup-runner.sh',
      startupCommand: 'claude',
      platform: 'windows',
      nonce: 'nonce-remote'
    })

    expect(setupScript(result)).toContain(
      'bash /remote/repo/.git/worktrees/feature/orca/setup-runner.sh'
    )
    expect(result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      '[ "$seen" = nonce-remote ]'
    )
  })

  it('preserves WSL shell metadata when sequencing native Windows runners', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      startupCommand: 'claude',
      platform: 'windows',
      shell: { family: 'posix', executable: 'wsl.exe' },
      nonce: 'nonce-wsl-shell'
    })

    expect(setupScript(result)).toContain('bash /mnt/c/repo/.git/orca/setup-runner.sh')
    expect(setupScript(result)).toContain(
      '/mnt/c/repo/.git/orca/setup-runner.sh.nonce-wsl-shell.done'
    )
    expect(result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      '/mnt/c/repo/.git/orca/setup-runner.sh.nonce-wsl-shell.done'
    )
  })

  it('launches a batch runner through the cmd launcher inside a Git Bash gate', () => {
    // Batch setup stays a cmd runner inside Git Bash; the gate remains bash to parse the already-POSIX-quoted startup command (#6896).
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.cmd',
      startupCommand: "claude 'fix the user'\\''s login'",
      platform: 'windows',
      shell: { family: 'posix' },
      nonce: 'nonce-gitbash-cmd'
    })

    expect(setupScript(result)).toContain(
      'powershell.exe -NoProfile -NonInteractive -EncodedCommand'
    )
    expect(result.setupCommand).not.toMatch(/bash\s+\S*setup-runner/)
    expect(decodePowerShellScript(setupScript(result))).toContain(
      "$runner = 'C:\\repo\\.git\\orca\\setup-runner.cmd'"
    )
    // PowerShell Invoke-Expression cannot parse POSIX apostrophe escaping; bash must evaluate startup.
    expect(result.setupCommand).toMatch(/^bash -lc /)
    expect(result.startupCommand).toMatch(/^bash -lc /)
    expect(result.startupCommand).not.toContain('Invoke-Expression')
    expect(result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      'eval "$ORCA_SEQUENCED_STARTUP_COMMAND"'
    )
    // Why: bash writes and reads the marker here, so it needs the /c/... form of the path.
    expect(setupScript(result)).toContain(
      '/c/repo/.git/orca/setup-runner.cmd.nonce-gitbash-cmd.done'
    )
    expect(result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      '/c/repo/.git/orca/setup-runner.cmd.nonce-gitbash-cmd.done'
    )
  })

  it.skipIf(process.platform !== 'win32')(
    'executes the native Windows setup-to-agent sequence through cmd.exe',
    async () => {
      const tempDir = join(makeTempDir(), 'path with spaces')
      mkdirSync(tempDir)
      const runnerScriptPath = join(tempDir, 'setup runner.cmd')
      const startupScriptPath = join(tempDir, 'agent-startup.cmd')
      const logPath = join(tempDir, 'sequence.log')

      writeFileSync(
        runnerScriptPath,
        ['@echo off', `>> "${logPath}" echo setup-done`, 'exit /b 0'].join('\r\n'),
        'utf8'
      )
      writeFileSync(
        startupScriptPath,
        ['@echo off', `>> "${logPath}" echo agent-start`, 'exit /b 0'].join('\r\n'),
        'utf8'
      )

      const commands = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: `cmd.exe /d /c "${startupScriptPath}"`,
        platform: 'windows',
        nonce: 'windows-sequence',
        waitTimeoutSeconds: 2
      })

      const setupExit = await waitForExit(
        spawnWindowsCommand(tempDir, 'run-setup.cmd', commands.setupCommand)
      )
      expect(setupExit.code).toBe(0)
      expect(readIfExists(`${runnerScriptPath}.windows-sequence.done`)).toBe(
        'windows-sequence:0\r\n'
      )

      const startupExit = await waitForExit(
        spawnWindowsCommand(
          tempDir,
          'run-startup.cmd',
          commands.startupCommand,
          commands.startupEnv
        )
      )

      expect(startupExit.code).toBe(0)
      expect(startupExit.stderr).toContain('Waiting for setup to finish before starting agent...')
      expect(readFileSync(logPath, 'utf8')).toBe('setup-done\r\nagent-start\r\n')
    },
    WINDOWS_PROCESS_TEST_TIMEOUT_MS
  )

  it.skipIf(process.platform === 'win32')(
    'ignores stale markers until the matching setup run finishes, even when startup launches first',
    async () => {
      const tempDir = makeTempDir()
      const runnerScriptPath = join(tempDir, 'setup-runner.sh')
      const startupScriptPath = join(tempDir, 'startup.sh')
      const logPath = join(tempDir, 'sequence.log')
      const markerPath = `${runnerScriptPath}.fresh-sequence.done`

      writeExecutable(
        runnerScriptPath,
        [
          '#!/bin/sh',
          `printf 'setup-start\\n' >> ${quoteSh(logPath)}`,
          'sleep 1',
          `printf 'setup-done\\n' >> ${quoteSh(logPath)}`
        ].join('\n')
      )
      writeExecutable(
        startupScriptPath,
        ['#!/bin/sh', `printf 'agent-start\\n' >> ${quoteSh(logPath)}`].join('\n')
      )
      writeFileSync(markerPath, 'stale:0\n', 'utf8')

      const commands = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: `bash ${quoteSh(startupScriptPath)}`,
        platform: 'posix',
        nonce: 'fresh-sequence',
        waitTimeoutSeconds: 5
      })

      const startupExitPromise = waitForExit(
        spawn('bash', ['-lc', commands.startupCommand], {
          stdio: 'pipe',
          env: { ...process.env, ...commands.startupEnv }
        })
      )
      await sleep(250)
      expect(readIfExists(logPath)).toBe('')
      expect(readFileSync(markerPath, 'utf8')).toBe('stale:0\n')

      const setupExit = await waitForExit(
        spawn('bash', ['-lc', commands.setupCommand], {
          stdio: 'pipe',
          env: { ...process.env, ...commands.setupEnv }
        })
      )
      expect(setupExit.code).toBe(0)

      const startupExit = await startupExitPromise
      expect(startupExit.code).toBe(0)

      expect(readFileSync(logPath, 'utf8')).toBe('setup-start\nsetup-done\nagent-start\n')
      expect(readIfExists(markerPath)).toBe('')
      expect(readIfExists(`${markerPath}.tmp`)).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'runs compound POSIX startup cleanup commands after setup succeeds',
    async () => {
      const tempDir = makeTempDir()
      const runnerScriptPath = join(tempDir, 'setup-runner.sh')
      const logPath = join(tempDir, 'sequence.log')

      writeExecutable(
        runnerScriptPath,
        ['#!/bin/sh', `printf 'setup-done\\n' >> ${quoteSh(logPath)}`].join('\n')
      )

      const commands = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: `printf 'agent-start\\n' >> ${quoteSh(logPath)}; printf 'cleanup\\n' >> ${quoteSh(logPath)}`,
        platform: 'posix',
        nonce: 'compound-sequence',
        waitTimeoutSeconds: 5
      })

      const setupExitPromise = waitForExit(
        spawn('bash', ['-lc', commands.setupCommand], {
          stdio: 'pipe',
          env: { ...process.env, ...commands.setupEnv }
        })
      )
      const startupExit = await waitForExit(
        spawn('bash', ['-lc', commands.startupCommand], {
          stdio: 'pipe',
          env: { ...process.env, ...commands.startupEnv }
        })
      )
      const setupExit = await setupExitPromise

      expect(setupExit.code).toBe(0)
      expect(startupExit.code).toBe(0)
      expect(readFileSync(logPath, 'utf8')).toBe('setup-done\nagent-start\ncleanup\n')
      const startupScript = commands.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]
      expect(startupScript).toContain('eval')
      expect(startupScript).not.toContain('exec printf')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'prefers the env-provided startup command after setup succeeds',
    async () => {
      const tempDir = makeTempDir()
      const runnerScriptPath = join(tempDir, 'setup-runner.sh')
      const startupScriptPath = join(tempDir, 'startup.sh')
      const logPath = join(tempDir, 'sequence.log')

      writeExecutable(
        runnerScriptPath,
        ['#!/bin/sh', `printf 'setup-done\\n' >> ${quoteSh(logPath)}`].join('\n')
      )
      writeExecutable(
        startupScriptPath,
        [
          '#!/bin/sh',
          'if [ "$FOO" = "bar" ]; then',
          `  printf 'env-start\\n' >> ${quoteSh(logPath)}`,
          'fi'
        ].join('\n')
      )

      const commands = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: `printf 'inline-start\\n' >> ${quoteSh(logPath)}`,
        platform: 'posix',
        nonce: 'env-sequence',
        waitTimeoutSeconds: 5
      })

      const setupExitPromise = waitForExit(
        spawn('bash', ['-lc', commands.setupCommand], {
          stdio: 'pipe',
          env: { ...process.env, ...commands.setupEnv }
        })
      )
      const startupExit = await waitForExit(
        spawn('bash', ['-lc', commands.startupCommand], {
          stdio: 'pipe',
          env: {
            ...process.env,
            ...commands.startupEnv,
            [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: `FOO=bar bash ${quoteSh(startupScriptPath)}; printf 'env-cleanup\\n' >> ${quoteSh(logPath)}`
          }
        })
      )
      const setupExit = await setupExitPromise

      expect(setupExit.code).toBe(0)
      expect(startupExit.code).toBe(0)
      expect(readFileSync(logPath, 'utf8')).toBe('setup-done\nenv-start\nenv-cleanup\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'times out instead of hanging forever when setup never writes a matching marker',
    async () => {
      const tempDir = makeTempDir()
      const runnerScriptPath = join(tempDir, 'setup-runner.sh')

      writeExecutable(runnerScriptPath, '#!/bin/sh\nexit 0\n')

      const commands = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: 'printf ready',
        platform: 'posix',
        nonce: 'timeout-sequence',
        waitTimeoutSeconds: 1
      })

      const startupExit = await waitForExit(
        spawn('bash', ['-lc', commands.startupCommand], {
          stdio: 'pipe',
          env: { ...process.env, ...commands.startupEnv }
        })
      )

      expect(startupExit.code).toBe(124)
      expect(startupExit.stderr).toContain('Timed out waiting for setup before starting agent.')
    }
  )
})

function setupScript(commands: SequencedSetupAgentCommands): string {
  return commands.setupEnv?.[SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV] ?? commands.setupCommand
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-setup-sequencing-'))
  TEMP_DIRS.push(dir)
  return dir
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8')
  chmodSync(path, 0o755)
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function spawnWindowsCommand(
  dir: string,
  filename: string,
  command: string,
  env: Record<string, string> = {}
): ReturnType<typeof spawn> {
  const scriptPath = join(dir, filename)
  // Avoid /s stripping Node’s batch-path quotes; argv spawning still exercises native cmd parsing.
  writeFileSync(scriptPath, `@echo off\r\n${command}\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8')
  return spawn('cmd.exe', ['/d', '/c', scriptPath], {
    stdio: 'pipe',
    env: { ...process.env, ...env }
  })
}

function decodePowerShellScript(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1]
  if (!encoded) {
    throw new Error('Missing PowerShell encoded command')
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
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
