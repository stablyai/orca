import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
import type {
  MarkdownPreviewWorkerRequest,
  MarkdownPreviewWorkerResult
} from './markdown-preview-document-types'

const engine = new MarkdownPreviewDocumentEngine()
const send = (result: MarkdownPreviewWorkerResult): void => self.postMessage(result)

self.onmessage = async (event: MessageEvent<MarkdownPreviewWorkerRequest>): Promise<void> => {
  const request = event.data
  try {
    switch (request.type) {
      case 'load':
        send({ id: request.id, type: 'loaded', document: engine.load(request.content) })
        break
      case 'blocks':
        send({ id: request.id, type: 'blocks', blocks: engine.blocks(request.indices) })
        break
      case 'search': {
        const result = await engine.search(request.query)
        if (result) {
          send({ id: request.id, type: 'search', ...result })
        }
        break
      }
      case 'cancel-search':
        engine.cancelSearch()
        break
    }
  } catch (error) {
    send({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'Preview processing failed.'
    })
  }
}
