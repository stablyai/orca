import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDockerSshRelayImage } from './docker-ssh-relay-image'

import type { TestInfo } from '@stablyai/playwright-test'

export const DOCKER_SSH_RELAY_REMOTE_REPO_PATH = '/tmp/orca-docker-relay-perf-repo'
export const DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH = '/tmp/orca-docker-proxy-jump-repo'
export const DOCKER_SSH_SECOND_HUB_REMOTE_REPO_PATH = '/tmp/orca-docker-second-hub-repo'

export type DockerSshRelayTarget = {
  containerName: string
  containerIp: string
  identityFile: string
  port: number
  tempDir: string
}

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

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function execDockerSshRelayTargetCommand(
  target: DockerSshRelayTarget,
  command: string
): string {
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
    '-o',
    'IdentitiesOnly=yes',
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
  const logs = spawnSync('docker', ['logs', target.containerName], {
    encoding: 'utf8',
    timeout: 10_000
  })
  throw new Error(
    `Timed out waiting for Docker SSH target: ${lastError}\n${logs.stderr || logs.stdout}`
  )
}

export function dockerSshRelayRepoSentinel(target: DockerSshRelayTarget, repoPath: string): string {
  return `${target.containerName}:${repoPath}`
}

function seedRemoteRepo(target: DockerSshRelayTarget, repoPath: string): void {
  const sentinel = dockerSshRelayRepoSentinel(target, repoPath)
  execDockerSshRelayTargetCommand(
    target,
    [
      `rm -rf ${shellQuote(repoPath)}`,
      `mkdir -p ${shellQuote(repoPath)}`,
      `cd ${shellQuote(repoPath)}`,
      'git init',
      'git config user.email e2e@test.local',
      'git config user.name "Orca Docker SSH E2E"',
      `printf '%s\\n' ${shellQuote(sentinel)} > .orca-e2e-destination-id`,
      `printf '%s\\n' ${shellQuote(`remote relay ${sentinel}`)} > README.md`,
      'git add README.md .orca-e2e-destination-id',
      'git commit -m initial'
    ].join(' && ')
  )
}

export function writeDockerSshRelayTargetFile(
  target: DockerSshRelayTarget,
  filePath: string,
  contents: string
): void {
  execDockerSshRelayTargetCommand(
    target,
    `printf '%s' ${shellQuote(contents)} > ${shellQuote(filePath)}`
  )
}

export function startDockerSshRelayTarget(testInfo: TestInfo): DockerSshRelayTarget {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'orca-ssh-docker-'))
  const identityFile = path.join(tempDir, 'id_ed25519')
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-q'])
  const publicKey = readFileSync(`${identityFile}.pub`, 'utf8').trim()
  const containerName = `orca-ssh-e2e-${testInfo.workerIndex}-${Date.now()}-${randomUUID().slice(0, 8)}`
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
        getDockerSshRelayImage(),
        'bash',
        '-lc',
        [
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
    const containerIp = run('docker', [
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      containerName
    ])
    if (!containerIp) {
      throw new Error(`Unable to read container IP for ${containerName}`)
    }
    target = { containerName, containerIp, identityFile, port, tempDir }
    waitForSsh(target)
    seedRemoteRepo(target, DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    seedRemoteRepo(target, DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH)
    seedRemoteRepo(target, DOCKER_SSH_SECOND_HUB_REMOTE_REPO_PATH)
    return target
  } catch (error) {
    cleanupDockerSshRelayTarget(
      target ?? { containerName, containerIp: '', identityFile, port: 0, tempDir }
    )
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
