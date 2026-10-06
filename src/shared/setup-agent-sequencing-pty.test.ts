import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as spawnPty } from 'node-pty'
import { describe, expect, it } from 'vitest'
import { createSequencedSetupAgentCommands } from './setup-agent-sequencing'

describe.skipIf(process.platform !== 'darwin')('setup buffered during zsh startup', () => {
  it.each([0, 7])(
    'reports setup status %s before the first prompt despite a long runner path',
    async (status) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-setup-buffered-'))
      const runnerDirectory = join(root, `repo-${'nested-worktree-'.repeat(10)}`)
      mkdirSync(runnerDirectory)
      const runnerScriptPath = join(runnerDirectory, 'setup-runner.sh')
      const releasePath = join(root, 'release-profile')
      const markerPath = `${runnerScriptPath}.buffered-setup.done`
      writeFileSync(runnerScriptPath, `#!/bin/sh\nprintf "setup-ran\\n"\nexit ${status}\n`)
      writeFileSync(
        join(root, '.zshrc'),
        [
          'printf "PROFILE_BLOCKED\\n"',
          'while [[ ! -f "$ORCA_TEST_RELEASE_PROFILE" ]]; do sleep 0.01; done',
          'PROMPT=""'
        ].join('\n')
      )
      const commands = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: 'printf agent-started',
        platform: 'posix',
        nonce: 'buffered-setup',
        waitTimeoutSeconds: 3
      })
      let output = ''
      const terminal = spawnPty('/bin/zsh', ['-d', '-i'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 24,
        cwd: root,
        env: {
          ...process.env,
          ...commands.setupEnv,
          HOME: root,
          ZDOTDIR: root,
          ORCA_TEST_RELEASE_PROFILE: releasePath
        }
      })
      const subscription = terminal.onData((data) => {
        output += data
      })
      const exited = new Promise<void>((resolve) => {
        terminal.onExit(() => resolve())
      })
      try {
        await expect.poll(() => output, { timeout: 2000 }).toContain('PROFILE_BLOCKED')
        terminal.write(`${commands.setupCommand}\r`)
        writeFileSync(releasePath, '')
        await expect
          .poll(
            () => {
              try {
                return readFileSync(markerPath, 'utf8')
              } catch {
                return ''
              }
            },
            { timeout: 2000 }
          )
          .toBe(`buffered-setup:${status}\n`)
        await expect.poll(() => output.match(/setup-ran/g)?.length ?? 0).toBe(1)
        const startup = spawnSync('bash', ['-c', commands.startupCommand], {
          env: { ...process.env, ...commands.startupEnv },
          encoding: 'utf8',
          timeout: 5000
        })
        expect(startup.status).toBe(status)
        expect(startup.stdout).toBe(status === 0 ? 'agent-started' : '')
        if (status !== 0) {
          expect(startup.stderr).toContain('Setup failed; skipping agent startup.')
        }
      } finally {
        subscription.dispose()
        terminal.kill()
        await exited
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
