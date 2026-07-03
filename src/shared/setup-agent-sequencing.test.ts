import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDefaultRepoHookSettings } from './constants'
import {
  createSequencedSetupAgentCommands,
  createSetupAgentSequenceNonce,
  getSetupAgentSequenceShellForTests,
  resolveSetupAgentSequenceLaunchCommand,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV
} from './setup-agent-sequencing'
import {
  DEFAULT_SETUP_AGENT_STARTUP_POLICY,
  shouldWaitForSetupBeforeAgentStartup
} from './setup-agent-startup-policy'

const TEMP_DIRS: string[] = []

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
    expect(result.startupCommand).toMatch(/^bash -lc /)
    expect(result.startupCommand).toContain('deadline=$((SECONDS + 9))')
    expect(result.startupCommand).not.toContain('date +%s')
    expect(result.startupCommand).toContain('Waiting for setup to finish before starting agent...')
    expect(result.startupCommand).toContain('[ "$seen" = nonce-123 ]')
    expect(result.startupCommand).toContain(
      'rm -f /repo/.git/orca/setup-runner.sh.nonce-123.done /repo/.git/orca/setup-runner.sh.nonce-123.done.tmp'
    )
    expect(result.startupCommand).toContain('exec codex')
    expect(result.startupCommand).toContain('fix bug')
    expect(result.startupEnv).toEqual(
      expect.objectContaining({
        [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: "codex 'fix bug'"
      })
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
    expect(first.startupCommand).toContain('/repo/.git/orca/setup-runner.sh.first-launch.done')
    expect(second.setupCommand).toContain('/repo/.git/orca/setup-runner.sh.second-launch.done')
    expect(second.startupCommand).toContain('/repo/.git/orca/setup-runner.sh.second-launch.done')
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

    expect(result.startupCommand).toContain("exec codex '\\''fix this; then test'\\''")
    expect(result.startupCommand).not.toContain('eval codex')
  })

  it('preserves POSIX inline environment assignment startup commands', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
      startupCommand: 'FOO=bar claude',
      platform: 'posix',
      nonce: 'nonce-env',
      waitTimeoutSeconds: 9
    })

    expect(result.startupCommand).toContain('FOO=bar claude')
    expect(result.startupCommand).toContain('exit "$?"')
    expect(result.startupCommand).not.toContain('exec FOO=bar claude')
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
    expect(result.startupCommand).toContain('[ "$seen" = nonce-remote ]')
  })

  it('wraps native Windows runners in a cmd-pinned setup and startup gate', () => {
    const result = createSequencedSetupAgentCommands({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.cmd',
      startupCommand: "codex --model gpt-5 'fix !PATH! & test'",
      platform: 'windows',
      nonce: 'nonce-win',
      waitTimeoutSeconds: 3
    })

    expect(result.setupCommand).toContain('cmd.exe /d /s /v:on /c')
    expect(result.setupCommand).toContain('cmd.exe /c ""C:\\repo\\.git\\orca\\setup-runner.cmd""')
    expect(result.setupCommand).toContain('echo !ORCA_SETUP_NONCE!:!ORCA_SETUP_STATUS!')
    expect(result.startupCommand.match(/powershell\.exe/g)).toHaveLength(1)
    expect(result.startupCommand).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass')
    expect(result.startupCommand).toContain('AddSeconds(3)')
    expect(result.startupCommand).toContain('!ORCA_SETUP_STATUS!')
    expect(result.startupCommand).toContain('Timed out waiting for setup before starting agent.')
    expect(result.startupCommand).toContain('Setup failed; skipping agent startup.')
    expect(result.startupCommand).toContain(
      'Remove-Item -LiteralPath $marker, $tmp -Force -ErrorAction SilentlyContinue'
    )
    expect(result.startupCommand).not.toContain('%ERRORLEVEL%')
    expect(result.startupCommand).not.toContain(' & ) else')
    expect(result.startupCommand).not.toContain('if ""!ORCA_SETUP_STATUS!""==""124""')
    expect(result.startupCommand).not.toContain('if not ""!ORCA_SETUP_STATUS!""==""0""')
    expect(result.startupCommand).not.toContain(
      `call !${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}!`
    )
    expect(result.startupCommand).toContain('Invoke-Expression')
    expect(result.startupCommand).not.toContain('fix !PATH! & test')
    expect(result.startupEnv).toEqual({
      [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: "codex --model gpt-5 'fix !PATH! & test'"
    })
  })

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
        spawn('bash', ['-lc', commands.startupCommand], { stdio: 'pipe' })
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
        spawn('bash', ['-lc', commands.startupCommand], { stdio: 'pipe' })
      )
      const setupExit = await setupExitPromise

      expect(setupExit.code).toBe(0)
      expect(startupExit.code).toBe(0)
      expect(readFileSync(logPath, 'utf8')).toBe('setup-done\nagent-start\ncleanup\n')
      expect(commands.startupCommand).toContain('eval')
      expect(commands.startupCommand).not.toContain('exec printf')
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
        spawn('bash', ['-lc', commands.startupCommand], { stdio: 'pipe' })
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
