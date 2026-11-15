import { NativeChatGalleryIndex } from './native-chat-gallery-index'
import type { NativeChatGalleryWorkerRequest } from './native-chat-gallery-worker-protocol'

const index = new NativeChatGalleryIndex()
self.onmessage = async (event: MessageEvent<NativeChatGalleryWorkerRequest>): Promise<void> => {
  const request = event.data
  const mark = `native-chat-gallery:worker:${request.revision}:${request.id}`
  performance.mark(`${mark}:start`)
  const result = await index.handle(request)
  performance.mark(`${mark}:end`)
  performance.measure(mark, `${mark}:start`, `${mark}:end`)
  self.postMessage(result)
  performance.clearMarks(`${mark}:start`)
  performance.clearMarks(`${mark}:end`)
  performance.clearMeasures(mark)
}
