import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
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

describe('createSequencedSetupAgentCommands', () => {
  it.skipIf(process.platform === 'win32').each([20, 200])(
    'expires %s stale markers and interrupted writes across runner identities',
    async (count) => {
      const tempDir = makeTempDir()
      const directory = join(tempDir, 'setup-completions')
      mkdirSync(directory)
      for (let index = 0; index < count; index++) {
        for (const suffix of ['.done', '.done.tmp']) {
          const file = join(directory, `old-${index}${suffix}`)
          writeFileSync(file, 'old:0')
          utimesSync(file, new Date(0), new Date(0))
        }
      }
      writeFileSync(join(directory, 'recent.done'), 'recent:0')
      writeFileSync(join(directory, 'recent.done.tmp'), 'recent:0')
      const runnerScriptPath = join(tempDir, 'new-runner-uuid.sh')
      writeExecutable(runnerScriptPath, '#!/bin/sh\nexit 0\n')
      const commands = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: '',
        platform: 'posix',
        nonce: 'new-attempt'
      })
      const result = await waitForExit(
        spawn('bash', ['-lc', commands.setupCommand], {
          stdio: 'pipe',
          env: { ...process.env, ...commands.setupEnv }
        })
      )
      expect(result.code).toBe(0)
      expect(readdirSync(directory).sort()).toEqual([
        'new-attempt.done',
        'recent.done',
        'recent.done.tmp'
      ])
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'preserves CMD expansion after required Setup',
    async () => {
      const tempDir = makeTempDir()
      const runnerScriptPath = join(tempDir, 'setup.cmd')
      const logPath = join(tempDir, 'agent.log')
      writeFileSync(runnerScriptPath, '@echo off\r\nexit /b 0\r\n')
      const commands = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: `echo %MODEL%> "${logPath}"`,
        platform: 'windows',
        startupShell: 'cmd',
        nonce: 'cmd-expansion',
        waitTimeoutSeconds: 5
      })
      const run = (command: string, env?: Record<string, string>) =>
        waitForExit(
          spawn('cmd.exe', ['/d', '/s', '/c', command], {
            stdio: 'pipe',
            env: { ...process.env, MODEL: 'selected-model', ...env }
          })
        )
      expect((await run(commands.setupCommand, commands.setupEnv)).code).toBe(0)
      expect((await run(commands.startupCommand, commands.startupEnv)).code).toBe(0)
      expect(readFileSync(logPath, 'utf8').trim()).toBe('selected-model')
    }
  )

  it.skipIf(process.platform === 'win32').each([0, 7])(
    'keeps one Setup result available to independent readers (exit %s)',
    async (status) => {
      const tempDir = makeTempDir()
      const runnerScriptPath = join(tempDir, 'setup-runner.sh')
      const logPath = join(tempDir, 'agent.log')
      writeExecutable(runnerScriptPath, `#!/bin/sh\nexit ${status}\n`)
      const commands = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: `printf 'started\\n' >> ${quoteSh(logPath)}`,
        platform: 'posix',
        nonce: 'shared-result',
        waitTimeoutSeconds: 1
      })
      const run = (command: string, env?: Record<string, string>) =>
        waitForExit(
          spawn('bash', ['-lc', command], { stdio: 'pipe', env: { ...process.env, ...env } })
        )
      expect((await run(commands.setupCommand, commands.setupEnv)).code).toBe(status)
      expect((await run(commands.startupCommand, commands.startupEnv)).code).toBe(status)
      // The second reader arrives after the first has exited.
      expect((await run(commands.startupCommand, commands.startupEnv)).code).toBe(status)
      if (status === 0) {
        expect(readFileSync(logPath, 'utf8')).toBe('started\nstarted\n')
      }
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
})

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
