import { NativeChatGalleryIndex } from './native-chat-gallery-index'
import {
  NativeChatGalleryWireDecoder,
  nativeChatGalleryPackets
} from './native-chat-gallery-transfer'
import type {
  NativeChatGalleryWorkerCommand,
  NativeChatGalleryWireRequest,
  NativeChatGalleryWireResult
} from './native-chat-gallery-worker-protocol'

const index = new NativeChatGalleryIndex()
let currentId = -1
let revision = -1
let incoming = new NativeChatGalleryWireDecoder()
let outgoing: ReturnType<typeof nativeChatGalleryPackets> | undefined
let next: ReturnType<ReturnType<typeof nativeChatGalleryPackets>['next']> | undefined

self.onmessage = async (event: MessageEvent<NativeChatGalleryWireRequest>): Promise<void> => {
  const request = event.data
  const identity = { id: request.id, revision: request.revision }
  const send = (result: NativeChatGalleryWireResult): void => self.postMessage(result)
  try {
    if (request.type === 'push') {
      if (request.id !== currentId || request.revision !== revision) {
        currentId = request.id
        revision = request.revision
        incoming = new NativeChatGalleryWireDecoder()
        outgoing = undefined
        next = undefined
      }
      incoming.push(request.tokens)
      if (!request.last) {
        send({ ...identity, type: 'ack' })
        return
      }
      const command = incoming.take<NativeChatGalleryWorkerCommand>()
      const mark = `native-chat-gallery:worker:${revision}:${currentId}`
      performance.mark(`${mark}:start`)
      const result = await index.handle({ ...command, ...identity })
      performance.mark(`${mark}:end`)
      performance.measure(mark, `${mark}:start`, `${mark}:end`)
      performance.clearMarks(`${mark}:start`)
      performance.clearMarks(`${mark}:end`)
      performance.clearMeasures(mark)
      outgoing = nativeChatGalleryPackets(result)
      next = outgoing.next()
    }
    if (
      request.id !== currentId ||
      request.revision !== revision ||
      !outgoing ||
      !next ||
      next.done
    ) {
      throw new Error('Gallery response stream is unavailable')
    }
    const tokens = next.value
    next = outgoing.next()
    send({ ...identity, type: 'data', tokens, last: next.done === true })
    if (next.done) {
      outgoing = undefined
      next = undefined
    }
  } catch {
    send({ ...identity, type: 'failed' })
  }
}
