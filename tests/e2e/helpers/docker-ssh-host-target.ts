import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDockerSshHostImage } from './docker-ssh-host-image'
import { quotePosixShell } from '../../../src/shared/wsl-login-shell-command'

import type { TestInfo } from '@stablyai/playwright-test'

export const DOCKER_SSH_HOST_REMOTE_REPO_PATH = '/tmp/orca-docker-relay-perf-repo'

export type DockerSshHostTarget = {
  containerName: string
  containerIp: string
  host: string
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

export function execDockerSshHostTargetCommand(
  target: DockerSshHostTarget,
  command: string
): string {
  return run('docker', ['exec', target.containerName, 'bash', '-lc', command], {
    timeoutMs: 60_000
  })
}

export function execDockerSshHostTargetControlCommand(
  target: DockerSshHostTarget,
  command: string
): string {
  return run('docker', [
    'exec',
    target.containerName,
    'bash',
    '--noprofile',
    '--norc',
    '-c',
    command
  ])
}

function sshArgs(target: DockerSshHostTarget, command: string): string[] {
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
    `root@${target.host}`,
    command
  ]
}

function waitForSsh(target: DockerSshHostTarget): void {
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

function seedRemoteRepo(target: DockerSshHostTarget, repoPath: string): void {
  const sentinel = `${target.containerName}:${repoPath}`
  execDockerSshHostTargetCommand(
    target,
    [
      `rm -rf ${quotePosixShell(repoPath)}`,
      `mkdir -p ${quotePosixShell(repoPath)}`,
      `cd ${quotePosixShell(repoPath)}`,
      'git init',
      'git config user.email e2e@test.local',
      'git config user.name "Orca Docker SSH E2E"',
      `printf '%s\\n' ${quotePosixShell(sentinel)} > .orca-e2e-destination-id`,
      `printf '%s\\n' ${quotePosixShell(`remote relay ${sentinel}`)} > README.md`,
      'git add README.md .orca-e2e-destination-id',
      'git commit -m initial'
    ].join(' && ')
  )
}

/**
 * Attempts a `direct-tcpip` channel to a closed loopback port using the host's own ssh client.
 *
 * The two outcomes are exactly what distinguishes the policies: a server that permits forwarding
 * reports a connect failure (port 9 is closed on any sane host), while one running
 * `AllowTcpForwarding no` refuses the channel itself with "administratively prohibited".
 */
function probeDockerSshHostTargetForwarding(target: DockerSshHostTarget): string {
  const result = spawnSync(
    'ssh',
    [
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
      '-W',
      '127.0.0.1:9',
      `root@${target.host}`
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }
  )
  return result.stderr || result.stdout || `exit ${result.status}`
}

/**
 * Denies TCP forwarding on the container's sshd the way a locked-down enterprise host does, so a
 * spec can prove browser routing fails closed while the terminal plane keeps working.
 *
 * sshd re-execs itself on SIGHUP and re-reads its config, which is why this HUPs PID 1 instead of
 * restarting it — PID 1 *is* sshd here (the entrypoint `exec`s it), so killing it takes the whole
 * container down. Only sessions opened after the re-exec are governed by the new policy, so call
 * this before the app connects. Returns once a real ssh client has confirmed the refusal, so a
 * config that silently failed to apply surfaces here rather than as a confusing assertion later.
 */
export function blockDockerSshHostTargetTcpForwarding(target: DockerSshHostTarget): void {
  execDockerSshHostTargetControlCommand(
    target,
    "printf '%s\\n' 'AllowTcpForwarding no' >> /etc/ssh/sshd_config; kill -HUP 1"
  )
  const deadline = Date.now() + 60_000
  let lastProbe = ''
  while (Date.now() < deadline) {
    lastProbe = probeDockerSshHostTargetForwarding(target)
    if (/administratively prohibited/i.test(lastProbe)) {
      return
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  throw new Error(
    `sshd never began refusing TCP forwarding after AllowTcpForwarding no: ${lastProbe}`
  )
}

export function writeDockerSshHostTargetFile(
  target: DockerSshHostTarget,
  filePath: string,
  contents: string
): void {
  execDockerSshHostTargetCommand(
    target,
    `printf '%s' ${quotePosixShell(contents)} > ${quotePosixShell(filePath)}`
  )
}

export function startDockerSshHostTarget(
  testInfo: Pick<TestInfo, 'workerIndex'>,
  /** A Docker volume mounted as `/root`, so several containers share one home as on NFS. */
  options: { sharedHomeVolume?: string } = {}
): DockerSshHostTarget {
  const host = process.env.ORCA_E2E_SSH_TARGET_HOST?.trim() || '127.0.0.1'
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) {
    if (process.env.ORCA_E2E_SSH_TARGET_HOST) {
      throw new Error(`ORCA_E2E_SSH_TARGET_HOST must be non-loopback: ${host}`)
    }
  }
  const bindHost = host === '127.0.0.1' ? host : '0.0.0.0'
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'orca-ssh-docker-'))
  const identityFile = path.join(tempDir, 'id_ed25519')
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-q'])
  const publicKey = readFileSync(`${identityFile}.pub`, 'utf8').trim()
  const containerName = `orca-ssh-e2e-${testInfo.workerIndex}-${Date.now()}-${randomUUID().slice(0, 8)}`
  let target: DockerSshHostTarget | null = null

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
        `${bindHost}::22`,
        // Each container is its own machine, so it gets its own machine-id.
        ...(options.sharedHomeVolume
          ? [
              '-v',
              `${options.sharedHomeVolume}:/root`,
              '-e',
              `MACHINE_ID=${randomUUID().replace(/-/g, '')}`
            ]
          : []),
        '-e',
        `AUTHORIZED_KEY=${publicKey}`,
        getDockerSshHostImage(),
        'bash',
        '-lc',
        [
          ...(options.sharedHomeVolume ? ['printf "%s\\n" "$MACHINE_ID" > /etc/machine-id'] : []),
          // Appended on a shared home, so each container's key keeps working.
          `printf "%s\\n" "$AUTHORIZED_KEY" ${options.sharedHomeVolume ? '>>' : '>'} /root/.ssh/authorized_keys`,
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
    target = { containerName, containerIp, host, identityFile, port, tempDir }
    waitForSsh(target)
    seedRemoteRepo(target, DOCKER_SSH_HOST_REMOTE_REPO_PATH)
    return target
  } catch (error) {
    cleanupDockerSshHostTarget(
      target ?? { containerName, containerIp: '', host, identityFile, port: 0, tempDir }
    )
    throw error
  }
}

export function cleanupDockerSshHostTarget(target: DockerSshHostTarget | null): void {
  if (!target) {
    return
  }
  tryRun('docker', ['rm', '-f', target.containerName], { timeoutMs: 20_000 })
  rmSync(target.tempDir, { recursive: true, force: true })
}
