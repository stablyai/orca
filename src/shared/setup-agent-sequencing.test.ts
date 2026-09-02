import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDefaultRepoHookSettings } from './constants'
import {
  createSequencedSetupAgentCommands,
  createSetupAgentSequenceNonce,
  SETUP_COMPLETE_MESSAGE,
  getSetupAgentSequenceShellForTests,
  resolveSetupAgentSequenceLaunchCommand,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from './setup-agent-sequencing'
import {
  DEFAULT_SETUP_AGENT_STARTUP_POLICY,
  shouldWaitForSetupBeforeAgentStartup
} from './setup-agent-startup-policy'

const TEMP_DIRS: string[] = []
const WINDOWS_PROCESS_TEST_TIMEOUT_MS = 30_000

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('createSequencedSetupAgentCommands', () => {
  it('defaults agent startup to immediate unless the wait policy is explicit', () => {
    expect(DEFAULT_SETUP_AGENT_STARTUP_POLICY).toBe('start-immediately')
    expect(getDefaultRepoHookSettings().setupAgentStartupPolicy).toBe('start-immediately')
    expect(shouldWaitForSetupBeforeAgentStartup(undefined)).toBe(false)
    expect(shouldWaitForSetupBeforeAgentStartup('start-immediately')).toBe(false)
    expect(shouldWaitForSetupBeforeAgentStartup('wait-for-setup')).toBe(true)
  })

  it('uses the original sequenced startup command as the launch hint when present', () => {
    expect(
      resolveSetupAgentSequenceLaunchCommand(
        { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'omp --resume' },
        'powershell wait-wrapper'
      )
    ).toBe('omp --resume')
    expect(
      resolveSetupAgentSequenceLaunchCommand(
        { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: '   ' },
        'powershell wait-wrapper'
      )
    ).toBe('powershell wait-wrapper')
  })

  it('wraps POSIX setup and startup commands with a matching nonce marker', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
      startupCommand: "codex 'fix bug'",
      platform: 'posix',
      nonce: 'nonce-123',
      waitTimeoutSeconds: 9
    })

    expect(result.setupCommand).toMatch(/^bash -lc /)
    expect(result.setupCommand).toContain('bash /repo/.git/orca/setup-runner.sh')
    expect(result.setupCommand).toContain('printf')
    expect(result.setupCommand).toContain('nonce-123 "$status"')
    expect(result.setupCommand).toContain(
      'mv -f /repo/.git/orca/setup-runner.sh.nonce-123.done.tmp'
    )
    const startupScript = result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]
    expect(result.startupCommand).toBe(
      `bash -lc 'eval "$${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV}"'`
    )
    expect(startupScript).toContain('deadline=$((SECONDS + 9))')
    expect(startupScript).not.toContain('date +%s')
    expect(startupScript).toContain('Waiting for setup to finish before starting agent...')
    expect(startupScript).toContain('[ "$seen" = nonce-123 ]')
    expect(startupScript).toContain(
      'rm -f /repo/.git/orca/setup-runner.sh.nonce-123.done /repo/.git/orca/setup-runner.sh.nonce-123.done.tmp'
    )
    expect(startupScript).toContain('exec codex')
    expect(startupScript).toContain('fix bug')
    expect(result.startupEnv).toEqual(
      expect.objectContaining({
        [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: "codex 'fix bug'",
        [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: startupScript
      })
    )
  })

  it('announces success so the pane stops showing the waiting line', () => {
    const commands = createSequencedSetupAgentCommands({
      runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
      startupCommand: 'codex',
      platform: 'posix',
      nonce: 'nonce-1'
    })
    const script = commands.startupEnv?.ORCA_SEQUENCED_STARTUP_SCRIPT ?? ''
    // Why ordering: `eval`/`exec` never returns, so a later message never renders.
    expect(script.indexOf(SETUP_COMPLETE_MESSAGE)).toBeGreaterThan(-1)
    expect(script.indexOf(SETUP_COMPLETE_MESSAGE)).toBeLessThan(
      script.indexOf('eval "$ORCA_SEQUENCED_STARTUP_COMMAND"')
    )
  })

  it('announces success on the native Windows gate too', () => {
    const commands = createSequencedSetupAgentCommands({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.cmd',
      platform: 'windows',
      startupCommand: 'codex',
      nonce: 'nonce-2'
    })
    const decoded = Buffer.from(
      commands.startupCommand.split('-EncodedCommand ')[1] ?? '',
      'base64'
    ).toString('utf16le')
    expect(decoded).toContain(SETUP_COMPLETE_MESSAGE)
    expect(decoded.indexOf(SETUP_COMPLETE_MESSAGE)).toBeLessThan(
      decoded.indexOf('Invoke-Expression $startup')
    )
  })

  it('leaves the failure and timeout messages as the only other outcomes', () => {
    const script =
      createSequencedSetupAgentCommands({
        runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
        startupCommand: 'codex',
        platform: 'posix',
        nonce: 'nonce-3'
      }).startupEnv?.ORCA_SEQUENCED_STARTUP_SCRIPT ?? ''
    // Silence on success is what made a healthy worktree look stuck.
    expect(script).toContain(SETUP_COMPLETE_MESSAGE)
    expect(script).toContain('Setup failed; skipping agent startup.')
    expect(script).toContain('Timed out waiting for setup before starting agent.')
  })

  it('keeps the POSIX terminal submission below the canonical input floor', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: `/repo/${'nested-worktree/'.repeat(100)}setup-runner.sh`,
      startupCommand: 'codex',
      platform: 'posix',
      nonce: 'long-path'
    })

    expect(result.startupCommand.length).toBeLessThan(256)
    expect(result.startupCommand).not.toContain('nested-worktree')
    expect(result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      'nested-worktree'
    )
  })

  it('uses launch-specific marker paths for overlapping setup gates', () => {
    const first = createSequencedSetupAgentCommands({
      runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
      startupCommand: 'claude',
      platform: 'posix',
      nonce: 'first-launch'
    })
    const second = createSequencedSetupAgentCommands({
      runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
      startupCommand: 'codex',
      platform: 'posix',
      nonce: 'second-launch'
    })

    expect(first.setupCommand).toContain('/repo/.git/orca/setup-runner.sh.first-launch.done')
    expect(first.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      '/repo/.git/orca/setup-runner.sh.first-launch.done'
    )
    expect(second.setupCommand).toContain('/repo/.git/orca/setup-runner.sh.second-launch.done')
    expect(second.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      '/repo/.git/orca/setup-runner.sh.second-launch.done'
    )
    expect(first.setupCommand).not.toContain('/repo/.git/orca/setup-runner.sh.second-launch.done')
    expect(second.setupCommand).not.toContain('/repo/.git/orca/setup-runner.sh.first-launch.done')
  })

  it('keeps simple POSIX startup commands eligible for exec when quoted text has separators', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
      startupCommand: "codex 'fix this; then test'",
      platform: 'posix',
      nonce: 'nonce-quoted',
      waitTimeoutSeconds: 9
    })

    const startupScript = result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]
    expect(startupScript).toContain("exec codex 'fix this; then test'")
    expect(startupScript).not.toContain('eval codex')
  })

  it('preserves POSIX inline environment assignment startup commands', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
      startupCommand: 'FOO=bar claude',
      platform: 'posix',
      nonce: 'nonce-env',
      waitTimeoutSeconds: 9
    })

    const startupScript = result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]
    expect(startupScript).toContain('FOO=bar claude')
    expect(startupScript).toContain('exit "$?"')
    expect(startupScript).not.toContain('exec FOO=bar claude')
  })

  it('uses the converted Linux marker path for WSL UNC runners on Windows', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath:
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
      startupCommand: 'claude',
      platform: 'windows',
      nonce: 'nonce-wsl'
    })

    expect(getSetupAgentSequenceShellForTests(resultPathWsl(), 'windows')).toBe('posix')
    expect(result.setupCommand).toContain(
      'bash /home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh'
    )
    expect(result.setupCommand).toContain(
      '/home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh.nonce-wsl.done'
    )
    expect(result.setupCommand).not.toContain('wsl.localhost')
  })

  it('keeps remote POSIX runners in bash even from a Windows client', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: '/remote/repo/.git/worktrees/feature/orca/setup-runner.sh',
      startupCommand: 'claude',
      platform: 'windows',
      nonce: 'nonce-remote'
    })

    expect(result.setupCommand).toContain(
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

    expect(result.setupCommand).toContain('bash /mnt/c/repo/.git/orca/setup-runner.sh')
    expect(result.setupCommand).toContain(
      '/mnt/c/repo/.git/orca/setup-runner.sh.nonce-wsl-shell.done'
    )
    expect(result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      '/mnt/c/repo/.git/orca/setup-runner.sh.nonce-wsl-shell.done'
    )
  })

  it('wraps native Windows runners in a cmd-pinned setup and startup gate', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.cmd',
      startupCommand: "codex --model gpt-5 'fix !PATH! & test'",
      platform: 'windows',
      nonce: 'nonce-win',
      waitTimeoutSeconds: 3
    })
    const setupPowerShell = decodePowerShellScript(result.setupCommand)
    const startupPowerShell = decodePowerShellScript(result.startupCommand)

    expect(result.setupCommand).toContain(
      'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand'
    )
    expect(setupPowerShell).toContain("$runner = 'C:\\repo\\.git\\orca\\setup-runner.cmd'")
    expect(setupPowerShell).toContain('$nonce + ":" + $setupStatus')
    expect(result.startupCommand.match(/powershell\.exe/g)).toHaveLength(1)
    expect(result.startupCommand).toContain(
      'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand'
    )
    expect(startupPowerShell).toContain('AddSeconds(3)')
    expect(startupPowerShell).toContain('Missing setup marker path.')
    expect(startupPowerShell).toContain('Timed out waiting for setup before starting agent.')
    expect(startupPowerShell).toContain('Setup failed; skipping agent startup.')
    expect(startupPowerShell).toContain(
      'Remove-Item -LiteralPath $marker, $tmp -Force -ErrorAction SilentlyContinue'
    )
    expect(result.startupCommand).not.toContain('%ERRORLEVEL%')
    expect(startupPowerShell).toContain('Invoke-Expression')
    expect(result.startupCommand).not.toContain('fix !PATH! & test')
    expect(result.startupEnv).toEqual({
      [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: "codex --model gpt-5 'fix !PATH! & test'"
    })
  })

  it('launches a batch runner through the cmd launcher inside a Git Bash gate', () => {
    // Regression (#6896): a Git Bash terminal with a batch setup script still gets a .cmd
    // runner, and the gate must not hand that runner to bash. The gate itself stays POSIX
    // because the Git Bash pane types it and quoted the startup command for bash.
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.cmd',
      startupCommand: "claude 'fix the user'\\''s login'",
      platform: 'windows',
      shell: { family: 'posix' },
      nonce: 'nonce-gitbash-cmd'
    })

    expect(result.setupCommand).toContain(
      'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand'
    )
    expect(result.setupCommand).not.toMatch(/bash\s+\S*setup-runner/)
    expect(decodePowerShellScript(result.setupCommand)).toContain(
      "$runner = 'C:\\repo\\.git\\orca\\setup-runner.cmd'"
    )
    // Why: PowerShell's `Invoke-Expression` cannot parse the POSIX `'\''` escaping a Git Bash
    // pane produces, so the gate that evaluates the startup command must be bash.
    expect(result.setupCommand).toMatch(/^bash -lc /)
    expect(result.startupCommand).toMatch(/^bash -lc /)
    expect(result.startupCommand).not.toContain('Invoke-Expression')
    expect(result.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toContain(
      'eval "$ORCA_SEQUENCED_STARTUP_COMMAND"'
    )
    // Why: bash writes and reads the marker here, so it needs the /c/... form of the path.
    expect(result.setupCommand).toContain(
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
        spawn('bash', ['-lc', commands.setupCommand], { stdio: 'pipe' })
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
        spawn('bash', ['-lc', commands.setupCommand], { stdio: 'pipe' })
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
        spawn('bash', ['-lc', commands.setupCommand], { stdio: 'pipe' })
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

describe('createSetupAgentSequenceNonce', () => {
  it('prefers crypto.randomUUID when available', () => {
    const originalCrypto = globalThis.crypto
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' })

    expect(createSetupAgentSequenceNonce()).toBe('uuid-1')

    vi.stubGlobal('crypto', originalCrypto)
  })
})

function resultPathWsl(): string {
  return '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh'
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
  // Why: /s strips the quotes Node adds for batch paths containing spaces;
  // argv spawning still exercises cmd.exe's native parser without that loss.
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
