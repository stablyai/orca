import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSequencedSetupAgentCommands } from './setup-agent-sequencing'

// Why: the POSIX gate evals the agent in a fresh `bash -lc`, which never reads
// Orca's shell wrapper, so it must carry the codex --no-daemon rule itself.
const roots: string[] = []
const gates: ChildProcess[] = []

afterEach(() => {
  for (const gate of gates.splice(0)) {
    gate.kill()
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function prepareGate(startupCommand: string) {
  const root = mkdtempSync(join(tmpdir(), 'orca-gate-codex-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // Why: `bash -l` reads /etc/profile, whose macOS path_helper moves the fixture bin
  // behind /usr/local/bin and /opt/homebrew/bin; re-prepend it so a real codex never runs.
  writeFileSync(join(root, '.bash_profile'), `export PATH=${JSON.stringify(bin)}:"$PATH"\n`)
  const runner = join(root, 'setup-runner.sh')
  const sequenced = createSequencedSetupAgentCommands({
    runnerScriptPath: runner,
    startupCommand,
    platform: 'posix',
    nonce: 'n1',
    // Why: a failed assertion must not leave a gate polling for the default two hours.
    waitTimeoutSeconds: 5
  })
  return {
    sequenced,
    // Why HOME and CODEX_HOME: `bash -l` must read no real profile, and nothing may touch ~/.codex.
    env: { HOME: root, CODEX_HOME: root, PATH: `${bin}:/usr/bin:/bin`, ...sequenced.startupEnv },
    finishSetup: (help: string) => {
      const codex = join(bin, 'codex')
      writeFileSync(
        codex,
        `#!/bin/sh\n[ "$1" = --help ] && { printf '%s\\n' '${help}'; exit 0; }\nprintf 'ARGV:%s\\n' "$*"\n`
      )
      chmodSync(codex, 0o755)
      writeFileSync(`${runner}.n1.done`, 'n1:0\n')
    }
  }
}

function runGate(startupCommand: string, help: string, env: Record<string, string> = {}): string {
  const gate = prepareGate(startupCommand)
  gate.finishSetup(help)
  return spawnSync('bash', ['-c', gate.sequenced.startupCommand], {
    encoding: 'utf8',
    env: { ...gate.env, ...env }
  }).stdout
}

describe.skipIf(process.platform === 'win32')('sequenced setup gate runs codex', () => {
  it('with --no-daemon when the binary supports it', () => {
    expect(runGate('codex --yolo', '--no-daemon')).toBe('ARGV:--no-daemon --yolo\n')
  })

  it.each([
    ['an old binary', 'codex --yolo', '--no-alt-screen', {}],
    ['a subcommand that needs the shared server', 'codex agents', '--no-daemon', {}],
    ['the opt-out', 'codex --yolo', '--no-daemon', { ORCA_CODEX_ISOLATE: '0' }]
  ])('unchanged for %s', (_case, command, help, env) => {
    expect(runGate(command, help, env)).toBe(`ARGV:${command.slice('codex '.length)}\n`)
  })

  it('with --no-daemon when setup is what installs codex', async () => {
    const gate = prepareGate('codex --yolo')
    const child = spawn('bash', ['-c', gate.sequenced.startupCommand], { env: gate.env })
    gates.push(child)
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    const exited = new Promise((resolve) => child.on('close', resolve))
    // Why after spawn: the gate is already waiting when setup puts codex on PATH.
    await new Promise((resolve) => setTimeout(resolve, 300))
    gate.finishSetup('--no-daemon')
    await exited
    expect(stdout).toBe('ARGV:--no-daemon --yolo\n')
  })
})
