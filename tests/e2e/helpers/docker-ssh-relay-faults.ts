import { execFileSync, spawnSync } from 'node:child_process'
import {
  execDockerSshRelayTargetControlCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

function run(args: string[], opts: { timeoutMs?: number } = {}): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs ?? 30_000
  }).trim()
}

function tryRun(args: string[], opts: { timeoutMs?: number } = {}): boolean {
  return (
    spawnSync('docker', args, {
      stdio: 'ignore',
      timeout: opts.timeoutMs ?? 10_000
    }).status === 0
  )
}

/**
 * Kill the per-connection sshd forks, leaving the listening daemon and every relay
 * process alive.
 *
 * Why: this is the fault the reconnect path is actually built for — the transport
 * dies while the remote session is still running, so a correct client re-attaches
 * rather than redeploying. Killing the container or the daemon tests a different
 * thing (see killDockerSshRelayDaemon / blackholeDockerSshRelayNetwork).
 */
export function dropDockerSshRelayTransport(target: DockerSshRelayTarget): number {
  // Why: the listener is the oldest sshd (PID 1 under the fixture entrypoint); every
  // other sshd/sshd-session is a live connection. OpenSSH >= 9.8 renames the child,
  // so both names are matched to keep this working across fixture image bumps.
  const output = execDockerSshRelayTargetControlCommand(
    target,
    `
daemon="$(pgrep -x sshd | sort -n | head -1)"
[ -n "$daemon" ] || { echo 0; exit 0; }
killed=0
for pid in $(pgrep -x sshd; pgrep -x sshd-session); do
  [ "$pid" = "$daemon" ] && continue
  kill -9 "$pid" 2>/dev/null && killed=$((killed+1))
done
echo "$killed"
`
  )
  const dropped = Number(output.trim().split('\n').at(-1))
  if (!Number.isInteger(dropped)) {
    throw new Error(`Unexpected transport-drop count from ${target.containerName}: ${output}`)
  }
  return dropped
}

/**
 * Freeze the container. TCP stays established and nothing is reset, so the client
 * sees silence rather than a closed socket.
 *
 * Why: this is the laptop-lid / network-stall shape, and the only fault that can
 * expose a liveness timeout firing on a session that is still perfectly healthy —
 * verified locally: a stream stalls while paused and resumes intact on unpause.
 */
export function stallDockerSshRelayTarget(target: DockerSshRelayTarget): void {
  run(['pause', target.containerName])
}

export function resumeDockerSshRelayTarget(target: DockerSshRelayTarget): void {
  run(['unpause', target.containerName])
}

export async function withStalledDockerSshRelayTarget<T>(
  target: DockerSshRelayTarget,
  body: () => Promise<T>
): Promise<T> {
  stallDockerSshRelayTarget(target)
  try {
    return await body()
  } finally {
    resumeDockerSshRelayTarget(target)
  }
}

function dockerSshRelayNetworks(target: DockerSshRelayTarget): string[] {
  const output = run([
    'inspect',
    '--format',
    '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}\n{{end}}',
    target.containerName
  ])
  return output.split('\n').filter((name) => name.length > 0)
}

/**
 * Detach every network, so packets are dropped rather than refused.
 *
 * Why: distinct from stalling — the remote keeps running and keeps producing output
 * while unreachable, which is what makes it the honest test for "did we lose bytes
 * during the outage".
 */
export function blackholeDockerSshRelayNetwork(target: DockerSshRelayTarget): string[] {
  const networks = dockerSshRelayNetworks(target)
  for (const network of networks) {
    run(['network', 'disconnect', network, target.containerName])
  }
  return networks
}

export function restoreDockerSshRelayNetwork(
  target: DockerSshRelayTarget,
  networks: string[]
): void {
  for (const network of networks) {
    tryRun(['network', 'connect', network, target.containerName], {
      timeoutMs: 20_000
    })
  }
}

export async function withBlackholedDockerSshRelayNetwork<T>(
  target: DockerSshRelayTarget,
  body: () => Promise<T>
): Promise<T> {
  const networks = blackholeDockerSshRelayNetwork(target)
  try {
    return await body()
  } finally {
    restoreDockerSshRelayNetwork(target, networks)
  }
}

/**
 * SIGKILL every detached relay process, leaving sshd reachable.
 *
 * Why: the session is genuinely gone, so this is the only fault where a client is
 * *supposed* to surface an explicit session-expired state instead of resuming. A
 * reconnect test that never exercises this cannot tell "resumed" from "silently
 * started over".
 */
export function killDockerSshRelayDaemon(target: DockerSshRelayTarget): number {
  const output = execDockerSshRelayTargetControlCommand(
    target,
    `
killed=0
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  argv=()
  mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || continue
  entry="\${argv[1]:-}"
  [ "\${entry##*/}" = relay.js ] || continue
  pid="\${proc##*/}"
  kill -9 "$pid" 2>/dev/null && killed=$((killed+1))
done
echo "$killed"
`
  )
  const killed = Number(output.trim().split('\n').at(-1))
  if (!Number.isInteger(killed)) {
    throw new Error(`Unexpected relay-kill count from ${target.containerName}: ${output}`)
  }
  return killed
}

/**
 * Undo any fault a failing test left behind.
 *
 * Why: a paused or network-detached container outlives the spec that faulted it and
 * poisons every later spec on the same worker, which reads as an unrelated flake.
 */
export function clearDockerSshRelayFaults(target: DockerSshRelayTarget | null): void {
  if (!target) {
    return
  }
  tryRun(['unpause', target.containerName])
  const attached = new Set(dockerSshRelayNetworks(target))
  for (const network of ['bridge']) {
    if (!attached.has(network)) {
      tryRun(['network', 'connect', network, target.containerName], {
        timeoutMs: 20_000
      })
    }
  }
}
