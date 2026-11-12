import 'monaco-editor/esm/vs/language/json/json.worker.js'

let nextRequestId = 0
const pending = new Map<
  number,
  {
    resolve: (response: Response) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

// The JSON service calls fetch lazily. Keep filesystem and network policy on the owning renderer.
globalThis.fetch = (input) => {
  const uri = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const id = nextRequestId++
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('JSON schema request timed out'))
    }, 10_000)
    pending.set(id, { resolve, reject, timer })
    globalThis.postMessage({ orcaJsonSchema: 'request', id, uri })
  })
}

globalThis.addEventListener(
  'message',
  (event: MessageEvent) => {
    if (event.data?.orcaJsonSchema !== 'response') {
      return
    }
    event.stopImmediatePropagation()
    const request = pending.get(event.data.id)
    if (!request) {
      return
    }
    pending.delete(event.data.id)
    clearTimeout(request.timer)
    if (typeof event.data.content === 'string') {
      request.resolve(new Response(event.data.content))
    } else {
      request.reject(new Error(event.data.error || 'Unable to load JSON schema'))
    }
  },
  { capture: true }
)
