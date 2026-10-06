import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { hashDockerFixtureDirectory } from './docker-ssh-relay-image'
import {
  netemArguments,
  type NetworkLinkShape,
  type NetworkOutageSchedule
} from './netem-arguments'

const execFileAsync = promisify(execFile)

/**
 * Network paths a test can make slow, lossy or dead, with tc/netem acting on packets.
 *
 * Two ways to put a path under test, both shaped and cut with the same calls:
 *
 * - `impairContainerNetwork` shapes everything an existing container sends and receives on one of
 *   its networks. The client connects to the container's own IP, so one TCP connection runs end
 *   to end and both real TCP stacks see the loss: retransmission, backoff, head-of-line blocking
 *   and slow connects all appear. Use this whenever the far side is a container (an SSH target,
 *   an Orca server).
 * - `startImpairedNetworkLink` forwards a local port through two containers and shapes the hop
 *   between them. The caller's own connection ends at the first container, so only the middle hop
 *   has TCP under loss. That is the shape of a relayed path, and it is the only option when the
 *   far side is a process on this machine. It does not show connect-time or client-side TCP
 *   effects.
 *
 * Both use one mechanism: a privileged shaper in the host's network and pid namespaces applies
 * netem on the host side of a container's veth, so netem is a forwarding hop and never sits on a
 * sender's own device.
 *
 * Never reach an impaired container through a published `localhost` port: Docker terminates that
 * connection and the client sees a perfect link.
 *
 * Uplink is the direction from the client to the target; downlink is the reverse.
 */
export type ImpairedContainerNetwork = {
  /** The container's IP on the shaped network. Connect to this, not to a published port. */
  address: string
  shaperContainer: string
}

export type ImpairedNetworkLink = {
  /** Connect to 127.0.0.1 on this port to reach the target through the link. */
  localPort: number
  nearContainer: string
  farContainer: string
  network: string
  shaperContainer: string
}

export type ImpairedNetworkPath = ImpairedNetworkLink | ImpairedContainerNetwork

const FIXTURE_PARTS = ['tests', 'e2e', 'fixtures', 'impaired-network-link']
const LINK_PORT = 7000
/** No delay, loss or rate cap in either direction. */
export const UNSHAPED: NetworkLinkShape = { uplink: { delayMs: 0 }, downlink: { delayMs: 0 } }

export function ensureImpairedNetworkLinkImage(root: string): string {
  const fixtureDir = path.join(root, ...FIXTURE_PARTS)
  const image = `orca-e2e-impaired-network-link:${hashDockerFixtureDirectory(fixtureDir)}`
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
    execFileSync('docker', ['build', '--tag', image, fixtureDir], {
      stdio: 'inherit',
      timeout: 300_000
    })
  }
  return image
}

function docker(args: string[], timeoutMs = 30_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs
  }).trim()
}

function removeContainers(...containers: string[]): void {
  spawnSync('docker', ['rm', '-f', ...containers], { stdio: 'ignore', timeout: 30_000 })
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitUntil(description: string, container: string, check: () => boolean): void {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (check()) {
      return
    }
    pause(200)
  }
  const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8', timeout: 10_000 })
  throw new Error(`${description}: ${logs.stderr || logs.stdout}`)
}

function succeeds(container: string, command: string): boolean {
  return (
    spawnSync('docker', ['exec', container, 'bash', '-c', command], {
      stdio: 'ignore',
      timeout: 10_000
    }).status === 0
  )
}

/**
 * One `docker exec` that sets both directions, so they change together.
 *
 * Why delete then add: `tc qdisc replace` on an existing netem keeps what the new arguments do not
 * mention (a rate cap survives) and keeps the packets it is holding. Deleting first gives exactly
 * the requested shape and discards the queue.
 */
function netemCommand(path: ImpairedNetworkPath, uplink: string[], downlink: string[]): string[] {
  const set = (file: string, args: string[]): string =>
    `d=$(cat /run/shaper/${file}); tc qdisc del dev "$d" root 2>/dev/null; ` +
    `tc qdisc add dev "$d" root handle 1: netem ${args.join(' ')}`
  return [
    'exec',
    path.shaperContainer,
    'sh',
    '-c',
    `${set('up', uplink)} && ${set('down', downlink)}`
  ]
}

const CUT = ['loss', '100%']

export function shapeImpairedNetwork(path: ImpairedNetworkPath, shape: NetworkLinkShape): void {
  docker(netemCommand(path, netemArguments(shape.uplink), netemArguments(shape.downlink)))
}

/**
 * Drops every packet in both directions until the path is shaped again. To TCP this is a tunnel
 * or a coverage hole: nothing is refused, packets just stop arriving. Packets the path was
 * holding are discarded.
 */
export function cutImpairedNetwork(path: ImpairedNetworkPath): void {
  docker(netemCommand(path, CUT, CUT))
}

/**
 * Cuts the path on a fixed cycle, restoring `shape` after each cut, until the returned function
 * is called. A fixed cycle keeps runs comparable. `onOutage` receives each cut's start and end
 * times, including one interrupted by stopping, so results can be lined up against them.
 *
 * The returned function restores `shape` and rejects if any cut or restore failed.
 */
export function scheduleNetworkOutages(
  path: ImpairedNetworkPath,
  shape: NetworkLinkShape,
  schedule: NetworkOutageSchedule,
  onOutage?: (startedAtMs: number, endedAtMs: number) => void
): () => Promise<void> {
  const restore = netemCommand(path, netemArguments(shape.uplink), netemArguments(shape.downlink))
  const cut = netemCommand(path, CUT, CUT)
  let stopped = false
  let wake: (() => void) | undefined
  const sleepUnlessStopped = (seconds: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  // Why async exec: a synchronous one would freeze the test's own event loop while it measures.
  const cycle = (async (): Promise<void> => {
    while (!stopped) {
      await sleepUnlessStopped(schedule.everySeconds)
      if (stopped) {
        return
      }
      await execFileAsync('docker', cut, { timeout: 30_000 })
      const startedAtMs = Date.now()
      try {
        // Why check again: a stop that landed during the cut's exec found no sleep to wake.
        if (!stopped) {
          await sleepUnlessStopped(schedule.forSeconds)
        }
      } finally {
        await execFileAsync('docker', restore, { timeout: 30_000 })
        onOutage?.(startedAtMs, Date.now())
      }
    }
  })()
  // Why: the failure is reported by the stop function; without this it is an unhandled rejection.
  cycle.catch(() => {})

  return async () => {
    stopped = true
    wake?.()
    await cycle
  }
}

type InspectedContainer = {
  State: { Pid: number }
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> }
}

function startShaper(
  root: string,
  container: string,
  network: string | undefined
): {
  address: string
  shaperContainer: string
} {
  const image = ensureImpairedNetworkLinkImage(root)
  const inspected: InspectedContainer = JSON.parse(docker(['inspect', container]))[0]
  const networks = inspected.NetworkSettings.Networks
  const names = Object.keys(networks)
  const chosen = network ?? (names.length === 1 ? names[0] : undefined)
  if (chosen === undefined || networks[chosen] === undefined) {
    throw new Error(
      `${container} is on networks [${names.join(', ')}]; name the one to impair${network ? ` (it is not on ${network})` : ''}`
    )
  }
  const address = networks[chosen].IPAddress
  const id = randomUUID().slice(0, 8)
  const shaperContainer = `orca-e2e-shaper-${id}`
  try {
    docker([
      'run',
      '-d',
      '--name',
      shaperContainer,
      '--privileged',
      '--net=host',
      // Why: the shaper enters the target's network namespace to find its interface and set one
      // segment per packet, so the target needs no tools and no privileges of its own.
      '--pid=host',
      '-e',
      `TARGET_PID=${inspected.State.Pid}`,
      '-e',
      `TARGET_IP=${address}`,
      '-e',
      // Interface names are limited to 15 characters.
      `IFB_NAME=ifb${id}`,
      image,
      'veth-shaper'
    ])
    waitUntil(`shaper for ${container} did not come up`, shaperContainer, () =>
      succeeds(shaperContainer, 'test -s /run/shaper/down')
    )
    shapeImpairedNetwork({ address, shaperContainer }, UNSHAPED)
  } catch (error) {
    stopShaper(shaperContainer)
    throw error
  }
  return { address, shaperContainer }
}

function stopShaper(shaperContainer: string): void {
  // Why stop before rm: the shaper undoes its changes on exit, and they live in the host's
  // network namespace, so they would outlast a killed container.
  spawnSync('docker', ['stop', '-t', '10', shaperContainer], { stdio: 'ignore', timeout: 30_000 })
  removeContainers(shaperContainer)
}

/**
 * Starts shaping an existing container's traffic on one of its networks. The path starts
 * unimpaired. `network` may be omitted when the container is on exactly one. The network must be a
 * bridge network: the shaper refuses anything that is not a veth pair.
 */
export function impairContainerNetwork(
  root: string,
  container: string,
  network?: string
): ImpairedContainerNetwork {
  return startShaper(root, container, network)
}

/**
 * Starts a link to `target`, a "host:port" as seen from Docker's default bridge: an IP address, or
 * `host.docker.internal:<port>` for a server on this machine. The link starts unimpaired.
 */
export function startImpairedNetworkLink(root: string, target: string): ImpairedNetworkLink {
  const image = ensureImpairedNetworkLinkImage(root)
  const id = randomUUID().slice(0, 8)
  const network = `orca-e2e-link-${id}`
  const nearContainer = `${network}-near`
  const farContainer = `${network}-far`
  const linkEnd = (name: string, forwardTo: string, extra: string[]): string[] => [
    'create',
    '--name',
    name,
    // Why: lets the far end reach a server running on the machine that runs Docker.
    '--add-host',
    'host.docker.internal:host-gateway',
    '-e',
    `LISTEN_PORT=${LINK_PORT}`,
    '-e',
    `FORWARD_TO=${forwardTo}`,
    ...extra,
    image,
    'link-end'
  ]
  let shaperContainer: string | undefined
  try {
    docker(['network', 'create', network])
    // Why: each end also sits on the default bridge, so reaching the caller or the target never
    // crosses the shaped network and only the hop between the two ends is impaired.
    docker(linkEnd(farContainer, target, []))
    docker(['network', 'connect', network, farContainer])
    docker(['start', farContainer])
    docker(
      linkEnd(nearContainer, `${farContainer}:${LINK_PORT}`, ['-p', `127.0.0.1::${LINK_PORT}`])
    )
    docker(['network', 'connect', network, nearContainer])
    docker(['start', nearContainer])
    const published = docker(['port', nearContainer, `${LINK_PORT}/tcp`])
    const localPort = Number(published.split(':').at(-1))
    if (!Number.isInteger(localPort) || localPort <= 0) {
      throw new Error(`Could not read the link's local port from: ${published}`)
    }
    const [targetHost, targetPort] = [
      target.slice(0, target.lastIndexOf(':')),
      target.split(':').at(-1)
    ]
    // Why probe the whole chain: Docker's port forwarder accepts a connection before anything
    // listens behind it, so a link that cannot reach its target would look ready.
    waitUntil(`link cannot reach ${target}`, farContainer, () =>
      succeeds(farContainer, `exec 3<>/dev/tcp/${targetHost}/${targetPort}`)
    )
    waitUntil('link is not forwarding', nearContainer, () =>
      succeeds(nearContainer, `exec 3<>/dev/tcp/127.0.0.1/${LINK_PORT}`)
    )
    shaperContainer = startShaper(root, farContainer, network).shaperContainer
    return { localPort, nearContainer, farContainer, network, shaperContainer }
  } catch (error) {
    if (shaperContainer) {
      stopShaper(shaperContainer)
    }
    removeContainers(nearContainer, farContainer)
    spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore', timeout: 30_000 })
    throw error
  }
}

/** Safe to call with a path that was never started. */
export function stopImpairedNetwork(path: ImpairedNetworkPath | null | undefined): void {
  if (!path) {
    return
  }
  stopShaper(path.shaperContainer)
  if ('network' in path) {
    removeContainers(path.nearContainer, path.farContainer)
    spawnSync('docker', ['network', 'rm', path.network], { stdio: 'ignore', timeout: 30_000 })
  }
}
