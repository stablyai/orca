type SendRequest = { target: EventTarget | null; browserPageId?: string }
type SendResult = 'opened' | 'empty' | null
const handlers = new Set<(request: SendRequest) => SendResult>()

export function registerBrowserAnnotationSendShortcut(
  handler: (request: SendRequest) => SendResult
): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

export function requestBrowserAnnotationSendMenu(request: SendRequest): SendResult {
  for (const handler of handlers) {
    const result = handler(request)
    if (result !== null) {
      return result
    }
  }
  return null
}
