import { randomBytes } from 'node:crypto'
import { beforeAll, expect, it, vi } from 'vitest'
import { resolveBaselineReleaseRef } from './release-checkout'
import { WORKING_TREE } from './versioned-terminal-wire'
import {
  loadMobileTerminalWireBuild,
  type MobileTerminalWireBuild
} from './versioned-mobile-terminal-wire'
import { runMobileInputSkewJourney } from './mobile-input-skew-journey'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(randomBytes(length))
}))

let current: MobileTerminalWireBuild
let baseline: MobileTerminalWireBuild
let references: Record<
  'current' | 'baseline',
  Awaited<ReturnType<typeof runMobileInputSkewJourney>>
>
beforeAll(async () => {
  ;[current, baseline] = await Promise.all([
    loadMobileTerminalWireBuild(WORKING_TREE),
    loadMobileTerminalWireBuild(resolveBaselineReleaseRef())
  ])
  references = {
    current: await runMobileInputSkewJourney(current, current),
    baseline: await runMobileInputSkewJourney(baseline, baseline)
  }
}, 180_000)

it.each([
  ['current', 'current'],
  ['baseline', 'baseline'],
  ['current', 'baseline'],
  ['baseline', 'current']
] as const)(
  'mobile encrypted input: %s host / %s client',
  async (host, client) => {
    const builds = { current, baseline }
    const result =
      host === client
        ? references[host]
        : await runMobileInputSkewJourney(builds[host], builds[client])
    expect(references.current.ordered, 'current peers must negotiate ordered input').toBe(true)
    expect(result.ordered, `${client} client against ${host} host`).toBe(
      references[host].ordered && references[client].ordered
    )
    expect(result.offered, 'client offer must remain stable across host versions').toEqual(
      references[client].offered
    )
    expect(result.binaryInputs + result.jsonInputs).toBe(3)
    expect(result.hex).toBe(Buffer.from('BOM:\ufeff한글\nline-2\t\x1b[A\x7f\x03\r').toString('hex'))
  },
  30_000
)

it('rejects same-length control-byte corruption at the real PTY', async () => {
  const corruptHost: MobileTerminalWireBuild = {
    ...current,
    codec: {
      ...current.codec,
      decodeTerminalStreamFrame: (bytes) => {
        const frame = current.codec.decodeTerminalStreamFrame(bytes)
        if (frame?.opcode !== current.codec.TerminalStreamOpcode.Input) {
          return frame
        }
        const payload = Uint8Array.from(frame.payload)
        payload[payload.length - 1] ^= 1
        return { ...frame, payload }
      }
    }
  }
  await expect(runMobileInputSkewJourney(corruptHost, current)).rejects.toThrow('to deeply equal')
})

it('cleans up a refused JSON send without an unhandled rejection', async () => {
  const refusingClient: MobileTerminalWireBuild = {
    ...current,
    MobileRelayRpcStreams: class extends current.MobileRelayRpcStreams {
      supportsTerminalStreamInput() {
        return false
      }
    },
    MobileE2EEV2PhysicalChannel: class extends current.MobileE2EEV2PhysicalChannel {
      sendText(text: string) {
        if (JSON.parse(text).method === 'terminal.send') {
          return false
        }
        return super.sendText(text)
      }
    }
  }
  await expect(runMobileInputSkewJourney(current, refusingClient)).rejects.toThrow(
    'Mobile skew JSON send failed'
  )
})
