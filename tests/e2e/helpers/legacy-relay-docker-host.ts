/**
 * A Docker SSH host left exactly as a 1.4.224 desktop leaves it on quit: that release's relay
 * running detached with a live shell, under `~/.orca-remote/relay-<version>/`.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { quotePosixShell } from '../../../src/shared/shell-argument-quoting'
import { relaySocketNameForInstanceId } from '../../../src/main/ssh/legacy-relay/ssh-relay-instance-id'
import { SshChannelMultiplexer } from '../../../src/main/ssh/ssh-channel-multiplexer'
import {
  leaveShellInReleasedRelay,
  openShellRelayTransport
} from '../cross-version-wire/released-relay-transport'
import { execDockerSshHostTargetCommand, type DockerSshHostTarget } from './docker-ssh-host-target'

const NODE_PTY_SLOT = 'linux-x64-glibc'

export type DockerReleasedRelay = { dir: string; version: string }

export type DockerRelayInstance = { sockPath: string; relayPtyId: string }

/**
 * Bundles the release's relay on the runner and lays it out on the host. Its `node-pty` is the
 * glibc-floor prebuild the orcad template carries: node-pty is N-API, so it loads on the host's Node.
 */
export async function installReleasedRelayOnDockerHost(
  target: DockerSshHostTarget,
  orcadTemplateDir: string
): Promise<DockerReleasedRelay> {
  const built: unknown = JSON.parse(
    execFileSync(
      path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
      [path.join(process.cwd(), 'tests', 'e2e', 'helpers', 'build-released-relay-bundle.mts')],
      { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'inherit'] }
    )
      .trim()
      .split('\n')
      .at(-1) ?? 'null'
  )
  if (
    typeof built !== 'object' ||
    built === null ||
    !('bundleDir' in built) ||
    !('version' in built) ||
    typeof built.bundleDir !== 'string' ||
    typeof built.version !== 'string'
  ) {
    throw new Error('Building the released relay printed no bundle')
  }
  const { bundleDir, version } = built
  const dir = `/root/.orca-remote/relay-${version}`
  const staging = mkdtempSync(path.join(os.tmpdir(), 'orca-legacy-relay-'))
  try {
    const pty = path.join(staging, 'node_modules', 'node-pty')
    cpSync(path.join(orcadTemplateDir, 'node_modules', 'node-pty'), pty, { recursive: true })
    cpSync(path.join(orcadTemplateDir, 'targets', NODE_PTY_SLOT, 'node_modules', 'node-pty'), pty, {
      recursive: true
    })
    // Why dereference: the bundle is a real file here, never the checkout's symlink.
    cpSync(path.join(bundleDir, 'relay.js'), path.join(staging, 'relay.js'), { dereference: true })
    execDockerSshHostTargetCommand(target, `mkdir -p ${quotePosixShell(dir)}`)
    execFileSync('docker', ['cp', `${staging}/.`, `${target.containerName}:${dir}`], {
      stdio: 'ignore',
      timeout: 60_000
    })
    execDockerSshHostTargetCommand(
      target,
      `printf '%s' ${quotePosixShell(version)} > ${quotePosixShell(`${dir}/.version`)}`
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return { dir, version }
}

function connectCommand(relay: DockerReleasedRelay, sockPath: string): string {
  return (
    `cd ${quotePosixShell(relay.dir)} && node relay.js --connect --sock-path ` +
    `${quotePosixShell(sockPath)} --credential-file ${quotePosixShell(`${sockPath}.credential`)}`
  )
}

/** The relay's own bridge, opened from the runner the way an SSH exec channel would. */
export function openDockerRelayTransport(
  target: DockerSshHostTarget,
  relay: DockerReleasedRelay,
  sockPath: string
): ReturnType<typeof openShellRelayTransport> {
  return openShellRelayTransport(
    `docker exec -i ${quotePosixShell(target.containerName)} sh -c ${quotePosixShell(
      connectCommand(relay, sockPath)
    )}`
  )
}

/**
 * Starts the detached daemon the way a 1.4.224 desktop launched it for `targetId`, with the
 * "keep terminals forever" grace, and leaves one echoing shell in it as that desktop's quit does.
 */
export async function startDockerRelayWithShell(
  target: DockerSshHostTarget,
  relay: DockerReleasedRelay,
  targetId: string,
  marker: string
): Promise<DockerRelayInstance> {
  const sockPath = `${relay.dir}/${relaySocketNameForInstanceId(targetId)}`
  execDockerSshHostTargetCommand(
    target,
    [
      `cd ${quotePosixShell(relay.dir)}`,
      `SHELL=/bin/sh nohup node relay.js --detached --grace-time 0 --sock-path ${quotePosixShell(
        sockPath
      )} --credential-file ${quotePosixShell(`${sockPath}.credential`)} ` +
        `> ${quotePosixShell(`${sockPath}.log`)} 2>&1 < /dev/null &`,
      `for i in $(seq 1 100); do [ -S ${quotePosixShell(sockPath)} ] && ` +
        `[ -f ${quotePosixShell(`${sockPath}.credential`)} ] && exit 0; sleep 0.1; done`,
      `cat ${quotePosixShell(`${sockPath}.log`)}; exit 1`
    ].join('\n')
  )
  const relayPtyId = await leaveShellInReleasedRelay(
    () => openDockerRelayTransport(target, relay, sockPath),
    `${targetId}-v1.4.224-desktop`,
    marker
  )
  return { sockPath, relayPtyId }
}

/** Owner without flow control; a holder that just disconnected is waited out, as any client would. */
async function claimOwnerWaitingOutGrace(mux: SshChannelMultiplexer): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await mux.request('pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'e2e-probe',
        requestedRole: 'session-owner'
      })
      return
    } catch (error) {
      const code: unknown =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code !== -32045 || attempt >= 60) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

/** Types a line into a relay shell over its own bridge and returns what it printed back. */
export async function echoThroughDockerRelay(
  target: DockerSshHostTarget,
  relay: DockerReleasedRelay,
  instance: DockerRelayInstance,
  line: string
): Promise<string> {
  const mux = new SshChannelMultiplexer(
    await openDockerRelayTransport(target, relay, instance.sockPath)
  )
  try {
    await claimOwnerWaitingOutGrace(mux)
    let output = ''
    mux.onNotification((method, params) => {
      if (method === 'pty.data' && params.id === instance.relayPtyId) {
        output += String(params.data)
      }
    })
    await mux.request('pty.attach', { id: instance.relayPtyId })
    mux.notify('pty.data', { id: instance.relayPtyId, data: `${line}\n` })
    const deadline = Date.now() + 15_000
    while (!output.includes(`GOT:${line}`) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return output
  } finally {
    mux.dispose()
  }
}

/** The PTY ids a relay still runs, asked through its own bridge. */
export async function listDockerRelayPtys(
  target: DockerSshHostTarget,
  relay: DockerReleasedRelay,
  sockPath: string
): Promise<string[]> {
  const mux = new SshChannelMultiplexer(await openDockerRelayTransport(target, relay, sockPath))
  try {
    const rows = await mux.request('pty.listProcesses', { includeForegroundProcessEvidence: false })
    return Array.isArray(rows)
      ? rows.flatMap((row: unknown) => {
          const id: unknown =
            typeof row === 'object' && row !== null && 'id' in row ? row.id : undefined
          return typeof id === 'string' ? [id] : []
        })
      : []
  } finally {
    mux.dispose()
  }
}
