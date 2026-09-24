// Cross-version coverage for the relay transport, paired the way the terminal and
// structured-session harnesses are: current code against a real published release.
//
// The relay is the one wire whose two endpoints are not both the app. The daemon lives
// on the remote host and keeps running across a desktop update, so a new bridge meets an
// old daemon as a matter of course — the handshake carries a version and the bridge has a
// dedicated exit code for refusing a mismatched one, which is what makes that pairing a
// designed state rather than an accident. Above it, the desktop encodes JSON-RPC frames
// with `src/main/ssh/relay-protocol.ts` and the daemon decodes them with its own
// `src/relay/protocol.ts`; the two are independent copies of one framing.
//
// Both frozen sides are read from an extracted release, so no expectation here says what
// a published build does or does not have.

import { beforeAll, describe, expect, it } from 'vitest'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

const WORKING_TREE = 'working-tree'

type DecodedFrame = { type: number; id: number; ack: number; payload: Buffer }

type RelayHostProtocol = {
  RELAY_VERSION: string
  MessageType: { Regular: number; Handshake: number; KeepAlive: number }
  FrameDecoder: new (
    onFrame: (frame: DecodedFrame) => void,
    onError?: (error: Error) => void
  ) => { feed: (chunk: Buffer) => void }
  encodeHandshakeFrame: (message: unknown) => Buffer
  parseHandshakeMessage: (payload: Buffer) => Record<string, unknown>
  parseJsonRpcMessage: (payload: Buffer) => Record<string, unknown>
}

type DesktopClientProtocol = {
  RELAY_VERSION: string
  encodeJsonRpcFrame: (message: unknown, id: number, ack: number) => Buffer
}

type RelayBuild = {
  label: string
  host: RelayHostProtocol
  client: DesktopClientProtocol
}

const HOST_MODULE = 'src/relay/protocol.ts'
const CLIENT_MODULE = 'src/main/ssh/relay-protocol.ts'

/** A module namespace narrowed to the protocol surface, once every member is proven present. */
function withExports<T>(label: string, module: Record<string, unknown>, names: string[]): T {
  const missing = names.filter((name) => module[name] === undefined)
  if (missing.length > 0) {
    throw new Error(`Build ${label} is missing relay protocol exports: ${missing.join(', ')}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every member the caller's type declares was just proven present on this namespace.
  return module as unknown as T
}

async function loadBuild(ref: string): Promise<RelayBuild> {
  const [host, client] =
    ref === WORKING_TREE
      ? await Promise.all([
          import('../../../src/relay/protocol'),
          import('../../../src/main/ssh/relay-protocol')
        ])
      : await (async () => {
          const checkout = await materializeReleaseCheckout(ref)
          return Promise.all([
            importReleaseCheckoutModule(checkout, `/${HOST_MODULE}`),
            importReleaseCheckoutModule(checkout, `/${CLIENT_MODULE}`)
          ])
        })()
  return {
    label: ref,
    host: withExports<RelayHostProtocol>(ref, host, [
      'RELAY_VERSION',
      'MessageType',
      'FrameDecoder',
      'encodeHandshakeFrame',
      'parseHandshakeMessage',
      'parseJsonRpcMessage'
    ]),
    client: withExports<DesktopClientProtocol>(ref, client, ['RELAY_VERSION', 'encodeJsonRpcFrame'])
  }
}

/** Every frame `decoder` recovers from one contiguous byte run, as a socket delivers it. */
function decodeAll(build: RelayBuild, bytes: Buffer): DecodedFrame[] {
  const frames: DecodedFrame[] = []
  const errors: Error[] = []
  const decoder = new build.host.FrameDecoder(
    (frame) => frames.push(frame),
    (error) => errors.push(error)
  )
  decoder.feed(bytes)
  expect(
    errors.map((error) => error.message),
    `${build.label} decoder errored`
  ).toEqual([])
  return frames
}

let current: RelayBuild
let baseline: RelayBuild

beforeAll(async () => {
  ;[current, baseline] = await Promise.all([
    loadBuild(WORKING_TREE),
    loadBuild(resolveBaselineReleaseRef())
  ])
}, SUITE_TIMEOUT_MS)

function describePairing(
  name: string,
  pair: () => { bridge: RelayBuild; daemon: RelayBuild }
): void {
  describe(name, () => {
    it('reads the peer handshake rather than failing to parse it', () => {
      const { bridge, daemon } = pair()
      const offered = bridge.host.encodeHandshakeFrame({
        type: 'orca-relay-handshake',
        version: bridge.host.RELAY_VERSION,
        endpointCredential: 'cross-version-credential'
      })
      const [frame] = decodeAll(daemon, offered)
      expect(frame?.type, `${daemon.label} did not read a handshake frame`).toBe(
        daemon.host.MessageType.Handshake
      )
      // The daemon must reach a verdict. Refusing the version is a verdict; throwing on the
      // frame is the failure this covers, because the bridge then cannot tell skew from a crash.
      const parsed = daemon.host.parseHandshakeMessage(frame?.payload ?? Buffer.alloc(0))
      expect(parsed).toMatchObject({
        type: 'orca-relay-handshake',
        version: bridge.host.RELAY_VERSION
      })
    })

    it('answers the peer handshake with a verdict the peer can read', () => {
      const { bridge, daemon } = pair()
      const agreed = daemon.host.RELAY_VERSION === bridge.host.RELAY_VERSION
      const reply = daemon.host.encodeHandshakeFrame(
        agreed
          ? { type: 'orca-relay-handshake-ok', version: daemon.host.RELAY_VERSION }
          : {
              type: 'orca-relay-handshake-mismatch',
              expected: daemon.host.RELAY_VERSION,
              got: bridge.host.RELAY_VERSION
            }
      )
      const [frame] = decodeAll(bridge, reply)
      expect(
        bridge.host.parseHandshakeMessage(frame?.payload ?? Buffer.alloc(0)),
        `${bridge.label} could not read ${daemon.label}'s handshake verdict`
      ).toMatchObject({
        type: agreed ? 'orca-relay-handshake-ok' : 'orca-relay-handshake-mismatch'
      })
    })

    it('carries a desktop JSON-RPC request to the peer daemon', () => {
      const { bridge, daemon } = pair()
      const request = { jsonrpc: '2.0', id: 7, method: 'preflight.probe', params: {} }
      const [frame] = decodeAll(daemon, bridge.client.encodeJsonRpcFrame(request, 7, 0))
      expect(frame?.type).toBe(daemon.host.MessageType.Regular)
      expect(daemon.host.parseJsonRpcMessage(frame?.payload ?? Buffer.alloc(0))).toMatchObject(
        request
      )
    })
  })
}

describePairing('new bridge against old daemon', () => ({ bridge: current, daemon: baseline }))
describePairing('old bridge against new daemon', () => ({ bridge: baseline, daemon: current }))

describe('relay version negotiation', () => {
  it('keeps the desktop and daemon copies of the version in step within a build', () => {
    // The desktop compares its own constant against the daemon's sentinel, so the two
    // copies disagreeing inside one build refuses every pairing that build takes part in.
    for (const build of [current, baseline]) {
      expect(build.client.RELAY_VERSION, `${build.label} desktop/daemon version skew`).toBe(
        build.host.RELAY_VERSION
      )
    }
  })
})
