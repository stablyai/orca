import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { TestInfo } from '@stablyai/playwright-test'

export const DOCKER_SSH_RELAY_REMOTE_REPO_PATH = '/tmp/orca-docker-relay-perf-repo'

export type DockerSshRelayTarget = {
  containerName: string
  identityFile: string
  port: number
  tempDir: string
}

const CONTAINER_IMAGE = process.env.ORCA_E2E_SSH_DOCKER_IMAGE ?? 'node:22-bookworm'

function run(command: string, args: string[], opts: { timeoutMs?: number } = {}): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs ?? 30_000
  }).trim()
}

function tryRun(command: string, args: string[], opts: { timeoutMs?: number } = {}): void {
  spawnSync(command, args, { stdio: 'ignore', timeout: opts.timeoutMs ?? 10_000 })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function dockerExec(target: DockerSshRelayTarget, command: string): string {
  return run('docker', ['exec', target.containerName, 'bash', '-lc', command], {
    timeoutMs: 60_000
  })
}

function sshArgs(target: DockerSshRelayTarget, command: string): string[] {
  return [
    '-i',
    target.identityFile,
    '-p',
    String(target.port),
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'BatchMode=yes',
    'root@127.0.0.1',
    command
  ]
}

function waitForSsh(target: DockerSshRelayTarget): void {
  const deadline = Date.now() + 90_000
  let lastError = ''
  while (Date.now() < deadline) {
    const result = spawnSync('ssh', sshArgs(target, 'true'), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000
    })
    if (result.status === 0) {
      return
    }
    lastError = result.stderr || result.stdout || `exit ${result.status}`
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
  }
  throw new Error(`Timed out waiting for Docker SSH target: ${lastError}`)
}

function seedRemoteRepo(target: DockerSshRelayTarget): void {
  dockerExec(
    target,
    [
      `rm -rf ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}`,
      `mkdir -p ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}`,
      `cd ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}`,
      'git init',
      'git config user.email e2e@test.local',
      'git config user.name "Orca Docker SSH E2E"',
      'printf "remote relay perf\\n" > README.md',
      'git add README.md',
      'git commit -m initial'
    ].join(' && ')
  )
}

export function startDockerSshRelayTarget(testInfo: TestInfo): DockerSshRelayTarget {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'orca-ssh-docker-'))
  const identityFile = path.join(tempDir, 'id_ed25519')
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-q'])
  const publicKey = readFileSync(`${identityFile}.pub`, 'utf8').trim()
  const containerName = `orca-ssh-e2e-${testInfo.workerIndex}-${Date.now()}`
  let target: DockerSshRelayTarget | null = null

  try {
    tryRun('docker', ['rm', '-f', containerName])
    run(
      'docker',
      [
        'run',
        '-d',
        '--name',
        containerName,
        '-p',
        '127.0.0.1::22',
        '-e',
        `AUTHORIZED_KEY=${publicKey}`,
        CONTAINER_IMAGE,
        'bash',
        '-lc',
        [
          'apt-get update >/tmp/apt-update.log',
          'DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server git >/tmp/apt-install.log',
          'mkdir -p /run/sshd /root/.ssh',
          'chmod 700 /root/.ssh',
          'printf "%s\\n" "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys',
          'chmod 600 /root/.ssh/authorized_keys',
          'git config --global user.email e2e@test.local',
          'git config --global user.name "Orca Docker SSH E2E"',
          'exec /usr/sbin/sshd -D -e'
        ].join(' && ')
      ],
      { timeoutMs: 120_000 }
    )

    const port = Number(run('docker', ['port', containerName, '22/tcp']).split(':').at(-1))
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Unable to read mapped SSH port for ${containerName}`)
    }
    target = { containerName, identityFile, port, tempDir }
    waitForSsh(target)
    seedRemoteRepo(target)
    return target
  } catch (error) {
    cleanupDockerSshRelayTarget(target ?? { containerName, identityFile, port: 0, tempDir })
    throw error
  }
}

export function cleanupDockerSshRelayTarget(target: DockerSshRelayTarget | null): void {
  if (!target) {
    return
  }
  tryRun('docker', ['rm', '-f', target.containerName], { timeoutMs: 20_000 })
  rmSync(target.tempDir, { recursive: true, force: true })
}
