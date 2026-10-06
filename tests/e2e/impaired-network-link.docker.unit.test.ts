import { execFileSync, spawnSync } from 'node:child_process'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cutImpairedNetwork,
  ensureImpairedNetworkLinkImage,
  impairContainerNetwork,
  shapeImpairedNetwork,
  startImpairedNetworkLink,
  stopImpairedNetwork,
  type ImpairedContainerNetwork,
  type ImpairedNetworkLink
} from './helpers/impaired-network-link'
import { netemArguments, type NetworkLinkShape } from './helpers/netem-arguments'
import {
  applyNetworkTravelProfile,
  NETWORK_TRAVEL_PROFILES
} from './helpers/network-travel-profiles'

const runDocker = process.env.ORCA_RUN_DOCKER_NETWORK_LINK_E2E === '1'
const ECHO_PORT = 9000

const symmetric = (direction: NetworkLinkShape['uplink']): NetworkLinkShape => ({
  uplink: direction,
  downlink: direction
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function connect(host: string, port: number): Promise<{ socket: net.Socket; connectMs: number }> {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () =>
      resolve({ socket, connectMs: performance.now() - started })
    )
    socket.once('error', reject)
  })
}

/** Sends one line every 50ms to an echo server; resolves with sorted round trips. */
async function measureRoundTrips(
  host: string,
  port: number,
  count: number
): Promise<{ roundTrips: number[]; connectMs: number }> {
  const { socket, connectMs } = await connect(host, port)
  socket.setNoDelay(true)
  const sentAt = new Map<string, number>()
  const roundTrips: number[] = []
  let buffered = ''
  socket.on('data', (chunk) => {
    buffered += chunk.toString()
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const started = sentAt.get(buffered.slice(0, end))
      buffered = buffered.slice(end + 1)
      if (started !== undefined) {
        roundTrips.push(performance.now() - started)
      }
    }
  })
  for (let i = 0; i < count; i++) {
    sentAt.set(String(i), performance.now())
    socket.write(`${i}\n`)
    await sleep(50)
  }
  const deadline = Date.now() + 30_000
  while (roundTrips.length < count && Date.now() < deadline) {
    await sleep(50)
  }
  socket.destroy()
  return { roundTrips: roundTrips.sort((a, b) => a - b), connectMs }
}

const median = (sorted: number[]): number => sorted[Math.floor(sorted.length / 2)]

describe('netem arguments', () => {
  it('writes delay, jitter, bursty loss, rate and queue', () => {
    expect(
      netemArguments({
        delayMs: 150,
        jitterMs: 30,
        jitterDistribution: 'paretonormal',
        loss: { kind: 'bursty', enterBadPercent: 1, leaveBadPercent: 20 },
        rateKbit: 2000,
        queuePackets: 200
      }).join(' ')
    ).toBe('delay 150ms 30ms distribution paretonormal loss gemodel 1% 20% rate 2000kbit limit 200')
  })

  it('refuses jitter without a rate limit, which would reorder packets', () => {
    expect(() => netemArguments({ delayMs: 50, jitterMs: 10 })).toThrow(/rateKbit/)
  })

  it('gives every travel profile a rate in both directions, since each has jitter', () => {
    for (const profile of Object.values(NETWORK_TRAVEL_PROFILES)) {
      expect(netemArguments(profile.shape.uplink)).toContain('rate')
      expect(netemArguments(profile.shape.downlink)).toContain('rate')
    }
  })
})

describe.runIf(runDocker)('impaired container network (end to end)', () => {
  const server = `orca-e2e-echo-${process.pid}`
  let path: ImpairedContainerNetwork | undefined

  const shaped = (): ImpairedContainerNetwork => {
    if (!path) {
      throw new Error('impaired container network did not start')
    }
    return path
  }
  const qdiscs = (): string =>
    execFileSync(
      'docker',
      ['exec', shaped().shaperContainer, 'sh', '-c', 'tc qdisc show dev "$(cat /run/shaper/up)"'],
      { encoding: 'utf8' }
    )

  beforeAll(() => {
    const image = ensureImpairedNetworkLinkImage(process.cwd())
    execFileSync('docker', [
      'run',
      '-d',
      '--name',
      server,
      image,
      'socat',
      `TCP-LISTEN:${ECHO_PORT},fork,reuseaddr,nodelay`,
      'EXEC:cat'
    ])
    path = impairContainerNetwork(process.cwd(), server)
  }, 400_000)

  afterAll(() => {
    stopImpairedNetwork(path)
    spawnSync('docker', ['rm', '-f', server], { stdio: 'ignore' })
  })

  it('delays the TCP handshake itself, so the client stack is on the impaired path', async () => {
    shapeImpairedNetwork(shaped(), symmetric({ delayMs: 100 }))
    const { roundTrips, connectMs } = await measureRoundTrips(shaped().address, ECHO_PORT, 30)
    expect(connectMs).toBeGreaterThan(190)
    expect(median(roundTrips)).toBeGreaterThan(195)
    expect(median(roundTrips)).toBeLessThan(260)
  }, 60_000)

  it('turns packet loss into late delivery, never missing bytes', async () => {
    shapeImpairedNetwork(
      shaped(),
      symmetric({ delayMs: 50, loss: { kind: 'random', percent: 10 } })
    )
    const { roundTrips } = await measureRoundTrips(shaped().address, ECHO_PORT, 80)
    expect(roundTrips).toHaveLength(80)
    // A retransmission costs at least one retransmission timeout on top of the 100ms round trip.
    expect(roundTrips.at(-1)).toBeGreaterThan(250)
  }, 90_000)

  it('holds traffic through a cut and delivers it after the path returns', async () => {
    const shape = symmetric({ delayMs: 50 })
    shapeImpairedNetwork(shaped(), shape)
    const measuring = measureRoundTrips(shaped().address, ECHO_PORT, 60)
    await sleep(1_000)
    cutImpairedNetwork(shaped())
    await sleep(2_000)
    shapeImpairedNetwork(shaped(), shape)
    const { roundTrips } = await measuring
    expect(roundTrips).toHaveLength(60)
    expect(roundTrips.at(-1)).toBeGreaterThan(2_000)
  }, 90_000)

  it('applies a full travel profile', async () => {
    shapeImpairedNetwork(shaped(), NETWORK_TRAVEL_PROFILES.inflightGeo.shape)
    const { roundTrips, connectMs } = await measureRoundTrips(shaped().address, ECHO_PORT, 30)
    expect(connectMs).toBeGreaterThan(500)
    expect(median(roundTrips)).toBeGreaterThan(600)
  }, 90_000)

  it('leaves nothing of the previous shape behind when reshaped', () => {
    shapeImpairedNetwork(shaped(), NETWORK_TRAVEL_PROFILES.subway.shape)
    expect(qdiscs()).toContain('rate')
    shapeImpairedNetwork(shaped(), symmetric({ delayMs: 20 }))
    expect(qdiscs()).toContain('delay 20ms')
    expect(qdiscs()).not.toContain('rate')
  })

  it("runs a profile's timed outages and reports each one", async () => {
    const outages: number[] = []
    const profile = {
      ...NETWORK_TRAVEL_PROFILES.lteStationary,
      outages: { everySeconds: 1, forSeconds: 1 }
    }
    const stop = applyNetworkTravelProfile(shaped(), profile, (startedAtMs, endedAtMs) =>
      outages.push(endedAtMs - startedAtMs)
    )
    const { roundTrips } = await measureRoundTrips(shaped().address, ECHO_PORT, 60)
    await stop()
    expect(outages.length).toBeGreaterThanOrEqual(1)
    expect(outages[0]).toBeGreaterThanOrEqual(1_000)
    expect(roundTrips).toHaveLength(60)
    expect(roundTrips.at(-1)).toBeGreaterThan(1_000)
    expect(qdiscs()).toContain('delay 35ms')
  }, 90_000)

  it('refuses a container on several networks unless one is named', () => {
    execFileSync('docker', ['network', 'create', `${server}-second`])
    execFileSync('docker', ['network', 'connect', `${server}-second`, server])
    try {
      expect(() => impairContainerNetwork(process.cwd(), server)).toThrow(/name the one/)
    } finally {
      execFileSync('docker', ['network', 'disconnect', `${server}-second`, server])
      execFileSync('docker', ['network', 'rm', `${server}-second`])
    }
  })
})

describe.runIf(runDocker)('impaired forwarding link (relay-shaped)', () => {
  let closeEchoServer: (() => void) | undefined
  let link: ImpairedNetworkLink | undefined

  const started = (): ImpairedNetworkLink => {
    if (!link) {
      throw new Error('impaired network link did not start')
    }
    return link
  }

  beforeAll(async () => {
    const server = net.createServer((socket) => socket.pipe(socket))
    closeEchoServer = () => server.close()
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('echo server has no port')
    }
    link = startImpairedNetworkLink(process.cwd(), `host.docker.internal:${address.port}`)
  }, 400_000)

  afterAll(() => {
    stopImpairedNetwork(link)
    closeEchoServer?.()
  })

  it('adds the configured delay in each direction and no more', async () => {
    shapeImpairedNetwork(started(), symmetric({ delayMs: 100 }))
    const { roundTrips } = await measureRoundTrips('127.0.0.1', started().localPort, 40)
    expect(roundTrips).toHaveLength(40)
    expect(median(roundTrips)).toBeGreaterThan(195)
    expect(median(roundTrips)).toBeLessThan(260)
  }, 60_000)

  it('holds traffic through a cut and delivers it after the link returns', async () => {
    const shape = symmetric({ delayMs: 50 })
    shapeImpairedNetwork(started(), shape)
    const measuring = measureRoundTrips('127.0.0.1', started().localPort, 60)
    await sleep(1_000)
    cutImpairedNetwork(started())
    await sleep(2_000)
    shapeImpairedNetwork(started(), shape)
    const { roundTrips } = await measuring
    expect(roundTrips).toHaveLength(60)
    expect(roundTrips.at(-1)).toBeGreaterThan(2_000)
  }, 60_000)
})
