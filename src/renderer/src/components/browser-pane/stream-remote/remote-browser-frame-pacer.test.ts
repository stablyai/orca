import { describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  decodeBrowserScreencastFrame,
  encodeBrowserScreencastFrame
} from '../../../../../shared/browser-screencast-protocol'
import { RemoteBrowserFramePacer } from './remote-browser-frame-pacer'
import type { RemoteBrowserStreamToken } from './remote-browser-stream-tokens'

const token: RemoteBrowserStreamToken = {
  tabId: 'tab',
  environmentId: 'host',
  remotePageId: 'page',
  generation: 1,
  operationGeneration: 1
}

function createHarness() {
  let currentToken = token
  const decoded: number[] = []
  const active: {
    frame: number
    signal: AbortSignal
    resolve: () => void
    reject: () => void
  }[] = []
  const renderFrame = vi.fn(
    (_token: RemoteBrowserStreamToken, bytes: Uint8Array, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          if (!signal.aborted) {
            decoded.push(decodeBrowserScreencastFrame(bytes)!.image[0]!)
          }
          resolve()
        }
        const fail = (): void => reject(new Error('decode failed'))
        signal.addEventListener('abort', fail, { once: true })
        active.push({
          frame: decodeBrowserScreencastFrame(bytes)!.image[0]!,
          signal,
          resolve: finish,
          reject: fail
        })
      })
  )
  const pacer = new RemoteBrowserFramePacer({
    isCurrent: (candidate) => candidate === currentToken,
    renderFrame
  })
  return {
    pacer,
    renderFrame,
    active,
    decoded,
    push: (frame: number, candidate = token) =>
      pacer.push(
        candidate,
        encodeBrowserScreencastFrame({
          opcode: BrowserScreencastOpcode.Frame,
          seq: frame,
          format: 'jpeg',
          metadata: {},
          image: new Uint8Array([frame])
        })
      ),
    replaceToken: (next: RemoteBrowserStreamToken) => {
      currentToken = next
    }
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve()
  }
}

describe('remote browser frame pacing', () => {
  it('shows the completed live frame while retaining only the newest pending frame', async () => {
    const harness = createHarness()
    for (let frame = 1; frame <= 200; frame += 1) {
      harness.push(frame)
    }
    expect(harness.renderFrame).toHaveBeenCalledTimes(1)
    harness.active[0]!.resolve()
    await settle()
    expect(harness.decoded).toEqual([1])
    expect(harness.active.map((frame) => frame.frame)).toEqual([1, 200])

    harness.active[1]!.resolve()
    await settle()
    expect(harness.decoded).toEqual([1, 200])
    expect(harness.renderFrame).toHaveBeenCalledTimes(2)
  })

  it('continues painting when frames arrive faster than they decode', async () => {
    const harness = createHarness()
    harness.push(0)
    for (let turn = 0; turn < 40; turn += 1) {
      harness.push(turn * 3 + 1)
      harness.push(turn * 3 + 2)
      harness.push(turn * 3 + 3)
      harness.active[turn]!.resolve()
      await settle()
      expect(harness.decoded).toHaveLength(turn + 1)
      expect(harness.renderFrame).toHaveBeenCalledTimes(turn + 2)
    }
    harness.active[40]!.resolve()
    await settle()
    expect(harness.decoded.at(-1)).toBe(120)
  })

  it('keeps streaming after an undecodable frame', async () => {
    const harness = createHarness()
    harness.push(1)
    harness.push(2)
    harness.active[0]!.reject()
    await settle()
    expect(harness.active.map((frame) => frame.frame)).toEqual([1, 2])
    harness.active[1]!.resolve()
    await settle()
    expect(harness.decoded).toEqual([2])
  })

  it('cancels the retired decode and drops its pending frame before restarting', async () => {
    const harness = createHarness()
    harness.push(1)
    harness.push(2)
    const replacement = { ...token, generation: 2 }
    harness.replaceToken(replacement)
    harness.pacer.clear()
    harness.push(3, replacement)
    await settle()
    expect(harness.active[0]!.signal.aborted).toBe(true)
    expect(harness.active.map((frame) => frame.frame)).toEqual([1, 3])
    harness.active[1]!.resolve()
    await settle()
    expect(harness.decoded).toEqual([3])
  })

  it('rejects stale frames both on arrival and before decoding a queued frame', async () => {
    const harness = createHarness()
    harness.push(1, { ...token, generation: 0 })
    expect(harness.renderFrame).not.toHaveBeenCalled()
    harness.push(2)
    harness.push(3)
    harness.replaceToken({ ...token, generation: 2 })
    harness.active[0]!.resolve()
    await settle()
    expect(harness.renderFrame).toHaveBeenCalledTimes(1)
  })

  it('does not replace a valid pending frame with unrelated binary traffic or invalid metadata', async () => {
    const harness = createHarness()
    harness.push(1)
    harness.push(2)
    harness.pacer.push(token, new Uint8Array([0x74, 1, 2, 3]))
    const malformed = encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 3,
      format: 'jpeg',
      metadata: {},
      image: new Uint8Array([3])
    })
    malformed[16] = 0xff
    harness.pacer.push(token, malformed)
    harness.active[0]!.resolve()
    await settle()
    expect(harness.active.map((frame) => frame.frame)).toEqual([1, 2])
    harness.active[1]!.resolve()
    await settle()
    expect(harness.decoded).toEqual([1, 2])
  })
})
