import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

const binary = process.env.ORCA_REAL_DSH_CLI

// No model call: published profile configuration and help establish the launcher contract.
describe.skipIf(!binary)('published DSH 0.2 CLI', () => {
  it('keeps positional and explicit headless profiles outside interactive recognition', async () => {
    if (!binary) {
      throw new Error('Set ORCA_REAL_DSH_CLI to the official dsh executable')
    }
    const root = await mkdtemp(join(tmpdir(), 'orca-dsh-cli-'))
    const env = { ...process.env, DSH_HOME: root, DEEPSEEK_API_KEY: '' }
    try {
      const version = await runProcess({ program: binary, args: ['--version'], cwd: root, env })
      expect(version.code).toBe(0)
      expect(version.stdout.trim()).toMatch(/^0\.2\./)
      for (const profile of ['headless', 'sdk', 'sdk-minimal', 'acp']) {
        for (const args of [[profile], ['--profile', profile]]) {
          const result = await runProcess({
            program: binary,
            args: [...args, '--dump-default-config'],
            cwd: root,
            env,
            timeoutMs: 30_000
          })
          expect(result.code).toBe(0)
          expect(result.stdout).toContain('@deepseek-ai/dsh-')
          const command = `"${binary}" ${args.join(' ')}`
          expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
          expect(
            recognizeAgentProcessFromCommandLine(command, { includeHeadlessOneShot: true })?.agent
          ).toBe('dsh')
        }
      }
      const help = await runProcess({
        program: binary,
        args: ['headless', '--help'],
        cwd: root,
        env,
        timeoutMs: 30_000
      })
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('Answer one task and exit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
