import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
