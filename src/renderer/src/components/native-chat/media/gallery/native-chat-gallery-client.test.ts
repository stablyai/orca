import { expect, it, vi } from 'vitest'
import {
  NativeChatGalleryClient,
  type NativeChatGallerySnapshot
} from './native-chat-gallery-client'
import { NativeChatGalleryIndex } from './native-chat-gallery-index'
import {
  nativeChatGalleryPackets,
  NativeChatGalleryWireDecoder
} from './native-chat-gallery-transfer'
import type {
  NativeChatGalleryWorkerCommand,
  NativeChatGalleryWireRequest,
  NativeChatGalleryWireResult
} from './native-chat-gallery-worker-protocol'

function snapshot(paths: string[]): NativeChatGallerySnapshot {
  return {
    scopeKey: 'chat',
    stoppedLabel: '',
    visuals: false,
    allowFileUriLinks: false,
    waitingSlots: [],
    slots: paths.map((path) => ({
      kind: 'message',
      message: {
        id: path,
        role: 'user',
        timestamp: 1,
        source: 'transcript',
        blocks: [{ type: 'image-ref', path }]
      },
      turnKey: undefined,
      activeTurnIsWorking: false,
      trailingRun: false,
      receipt: undefined,
      status: undefined,
      folded: false,
      drawsMessage: true,
      turnFolds: false,
      turnDiff: undefined,
      estimatedHeight: 100
    }))
  }
}

it('publishes a newer revision without releasing an outstanding put and preserves selected custody', async () => {
  const started = Promise.withResolvers<void>()
  let holdNextPut = false
  let releasePut: (() => Promise<void>) | undefined
  class ControlledWorker {
    onmessage: ((event: { data: NativeChatGalleryWireResult }) => void) | null = null
    onerror: (() => void) | null = null
    private readonly index = new NativeChatGalleryIndex()
    private incoming = new NativeChatGalleryWireDecoder()
    private outgoing: ReturnType<typeof nativeChatGalleryPackets> | undefined
    private terminated = false

    terminate(): void {
      this.terminated = true
    }

    postMessage(request: NativeChatGalleryWireRequest): void {
      if (this.terminated) {
        throw new Error('Controlled worker was terminated')
      }
      queueMicrotask(() => void this.receive(request))
    }

    private async receive(request: NativeChatGalleryWireRequest): Promise<void> {
      const identity = { id: request.id, revision: request.revision }
      const send = (result: NativeChatGalleryWireResult): void => {
        this.onmessage?.({ data: result })
      }
      const respond = (): void => {
        const outgoing = this.outgoing
        if (!outgoing) {
          throw new Error('Missing controlled response')
        }
        const packet = outgoing.next()
        if (packet.done) {
          throw new Error('Missing controlled response')
        }
        const following = outgoing.next()
        if (!following.done) {
          throw new Error('Controlled fixture response must fit one packet')
        }
        send({ ...identity, type: 'data', tokens: packet.value, last: true })
      }
      if (request.type === 'pull') {
        respond()
        return
      }
      this.incoming.push(request.tokens)
      if (!request.last) {
        send({ ...identity, type: 'ack' })
        return
      }
      const command = this.incoming.take<NativeChatGalleryWorkerCommand>()
      this.incoming = new NativeChatGalleryWireDecoder()
      const finish = async (): Promise<void> => {
        this.outgoing = nativeChatGalleryPackets(
          await this.index.handle({ ...command, ...identity })
        )
        respond()
      }
      if (holdNextPut && command.type === 'put') {
        holdNextPut = false
        releasePut = finish
        started.resolve()
      } else {
        await finish()
      }
    }
  }
  vi.stubGlobal('Worker', ControlledWorker)
  const client = new NativeChatGalleryClient()
  try {
    const original = await client.index(snapshot(['/tmp/selected.png']))
    const selected = original?.entries[0]?.key
    holdNextPut = true
    const obsolete = client.index(snapshot(['/tmp/held.png']))
    await started.promise
    const latestSnapshot = snapshot(['/tmp/selected.png', '/tmp/latest.png'])
    const latest = await client.index(latestSnapshot)
    expect(await obsolete).toBeNull()
    expect(latest?.entries.map((entry) => entry.source)).toEqual([
      '/tmp/selected.png',
      '/tmp/latest.png'
    ])
    expect(latest?.entries.find((entry) => entry.key === selected)?.source).toBe(
      '/tmp/selected.png'
    )
    await releasePut?.()
    const afterLateReply = await client.index(latestSnapshot)
    expect(afterLateReply?.entries.map((entry) => entry.source)).toEqual([
      '/tmp/selected.png',
      '/tmp/latest.png'
    ])
    expect(afterLateReply?.entries.find((entry) => entry.key === selected)?.source).toBe(
      '/tmp/selected.png'
    )
  } finally {
    client.close()
    vi.unstubAllGlobals()
  }
})
