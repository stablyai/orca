// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LSP_PORT_WINDOW_MESSAGE } from '../../../../shared/language-server-types'

// Why: type-only imports are erased, so vi.resetModules() still reloads fresh module state.
import type * as OpenerModule from './lsp-session-opener'
import type * as PortClientModule from './lsp-port-client'

const originalAddEventListener = window.addEventListener.bind(window)

let getLspClient: typeof OpenerModule.getLspClient
let resetLspClients: typeof OpenerModule.resetLspClients
let retainLspClient: typeof OpenerModule.retainLspClient
let releaseLspClient: typeof OpenerModule.releaseLspClient
let LspPortClientClass: typeof PortClientModule.LspPortClient
let openFn: ReturnType<typeof vi.fn>
let addEventListenerSpy: { mockRestore: () => void } | null = null
const addedListeners: EventListenerOrEventListenerObject[] = []

beforeEach(async () => {
  vi.resetModules()

  openFn = vi.fn().mockResolvedValue({ ok: false })
  Reflect.set(window, 'api', { lsp: { open: openFn } })

  // Why: track the opener's message listener so afterEach can remove it between tests.
  addedListeners.splice(0)
  addEventListenerSpy = vi
    .spyOn(window, 'addEventListener')
    .mockImplementation(
      (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ) => {
        if (!listener) {
          return
        }
        if (type === 'message') {
          addedListeners.push(listener)
        }
        originalAddEventListener(type, listener, options)
      }
    )

  const portClientMod = await import('./lsp-port-client')
  LspPortClientClass = portClientMod.LspPortClient
  const mod = await import('./lsp-session-opener')
  getLspClient = mod.getLspClient
  resetLspClients = mod.resetLspClients
  retainLspClient = mod.retainLspClient
  releaseLspClient = mod.releaseLspClient
})

afterEach(() => {
  vi.clearAllMocks()
  for (const listener of addedListeners) {
    window.removeEventListener('message', listener)
  }
  addedListeners.splice(0)
  addEventListenerSpy?.mockRestore()
  addEventListenerSpy = null
})

function createPortPair(): { server: MessagePort; client: MessagePort } {
  const channel = new MessageChannel()
  return { server: channel.port2, client: channel.port1 }
}

// Why: a real port with a spied close() lets tests observe exactly what the opener closes.
function createFakePort(): { port: MessagePort; close: ReturnType<typeof vi.spyOn> } {
  const port = new MessageChannel().port1
  return { port, close: vi.spyOn(port, 'close') }
}

function requireClient<T>(client: T | null): T {
  if (!client) {
    throw new Error('expected an LSP client')
  }
  return client
}

function dispatchPortMessage(requestId: string, port: MessagePort) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: LSP_PORT_WINDOW_MESSAGE, requestId },
      source: window,
      ports: [port]
    })
  )
}

describe('getLspClient', () => {
  it('a successful open returns a client, and a second call returns the same cached client without calling open again', async () => {
    const { server, client } = createPortPair()
    openFn.mockImplementation(({ requestId }) => {
      setTimeout(() => dispatchPortMessage(requestId, client), 10)
      return Promise.resolve({ ok: true })
    })

    server.start()

    const result1 = getLspClient('worktree-1', 'typescript')
    const client1 = await result1

    expect(client1).toBeInstanceOf(LspPortClientClass)
    expect(openFn).toHaveBeenCalledTimes(1)

    // Second call should return the same cached client
    const result2 = getLspClient('worktree-1', 'typescript')
    const client2 = await result2

    expect(client2).toBe(client1)
    expect(openFn).toHaveBeenCalledTimes(1) // Still only called once

    client1?.close()
  })

  it('two concurrent calls after the cached client closed produce exactly one new open call', async () => {
    openFn.mockImplementation(({ requestId }) => {
      setTimeout(() => {
        const { client: portClient } = createPortPair()
        dispatchPortMessage(requestId, portClient)
      }, 10)
      return Promise.resolve({ ok: true })
    })

    // First call to populate cache
    const client1 = await getLspClient('worktree-1', 'typescript')
    expect(client1).not.toBeNull()
    expect(openFn).toHaveBeenCalledTimes(1)

    // Close the cached client
    client1?.close()

    // Two concurrent calls after close
    const p1 = getLspClient('worktree-1', 'typescript')
    const p2 = getLspClient('worktree-1', 'typescript')

    await Promise.all([p1, p2])

    // Exactly one new open call should have been made
    expect(openFn).toHaveBeenCalledTimes(2)
  })

  it('a refusal (ok: false) returns null and is cached, so a second call within the TTL does not call open', async () => {
    openFn.mockResolvedValue({ ok: false })

    const result1 = await getLspClient('worktree-1', 'typescript')
    expect(result1).toBeNull()
    expect(openFn).toHaveBeenCalledTimes(1)

    // Second call within TTL should not call open again
    const result2 = await getLspClient('worktree-1', 'typescript')
    expect(result2).toBeNull()
    expect(openFn).toHaveBeenCalledTimes(1) // Still only called once
  })

  it('a message whose source is not window is ignored, but correct-source message still resolves', async () => {
    const { server: serverA, client: clientA } = createPortPair()
    const { server: serverB, client: clientB } = createPortPair()
    serverA.start()
    serverB.start()

    let capturedRequestId: string | undefined
    let messageFromA = false
    let messageFromB = false

    // Listen on serverA to see if request arrives (it shouldn't)
    serverA.addEventListener('message', () => {
      messageFromA = true
    })
    // Listen on serverB to handle request
    serverB.addEventListener('message', (event) => {
      messageFromB = true
      // Reply to the request so client.request() resolves
      serverB.postMessage({ jsonrpc: '2.0', id: event.data.id, result: 'ok' })
    })

    openFn.mockImplementation(({ requestId }) => {
      capturedRequestId = requestId
      // Send port with wrong source first (should be closed/ignored)
      setTimeout(() => {
        if (capturedRequestId) {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { type: LSP_PORT_WINDOW_MESSAGE, requestId: capturedRequestId },
              source: new MessageChannel().port1,
              ports: [clientA]
            })
          )
        }
      }, 5)
      // Send correct message with right source (should be used)
      setTimeout(() => {
        if (capturedRequestId) {
          dispatchPortMessage(capturedRequestId, clientB)
        }
      }, 10)
      return Promise.resolve({ ok: true })
    })

    const client = await getLspClient('worktree-1', 'typescript')
    expect(client).toBeInstanceOf(LspPortClientClass)

    // Send request through client; it should arrive on serverB, not serverA
    await expect(requireClient(client).request('textDocument/hover', {})).resolves.toBe('ok')
    expect(messageFromB).toBe(true)
    expect(messageFromA).toBe(false)
  })

  it('a port for an unknown requestId is closed', async () => {
    // The port listener is installed lazily by the first open attempt.
    await getLspClient('worktree-1', 'typescript')
    const { port, close } = createFakePort()

    dispatchPortMessage('unknown-id', port)

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('port arriving before open resolves is captured and used immediately', async () => {
    const { server, client } = createPortPair()
    server.start()

    let capturedRequestId: string | undefined
    openFn.mockImplementation(({ requestId }) => {
      capturedRequestId = requestId
      // Dispatch port synchronously before resolving
      if (capturedRequestId) {
        dispatchPortMessage(capturedRequestId, client)
      }
      // Resolve on next tick
      return Promise.resolve({ ok: true })
    })

    const result = await getLspClient('worktree-1', 'typescript')
    expect(result).toBeInstanceOf(LspPortClientClass)

    // Prove port is live by sending request through it
    server.addEventListener('message', (event) => {
      server.postMessage({ jsonrpc: '2.0', id: event.data.id, result: 'alive' })
    })
    await expect(requireClient(result).request('ping', {})).resolves.toBe('alive')
  })

  it('early port is closed if open fails', async () => {
    const { port, close } = createFakePort()
    let closedBeforeOpenSettled: boolean | undefined

    openFn.mockImplementation(({ requestId }) => {
      // Deliver the port while open is still pending, then fail the open.
      dispatchPortMessage(requestId, port)
      closedBeforeOpenSettled = close.mock.calls.length > 0
      return Promise.resolve({ ok: false })
    })

    const result = await getLspClient('worktree-1', 'typescript')

    expect(result).toBeNull()
    expect(openFn).toHaveBeenCalledTimes(1)
    // Proves the port was a live waiter's port (not closed as unknown) when it arrived.
    expect(closedBeforeOpenSettled).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('resetLspClients closes the tracked client', async () => {
    const { server, client } = createPortPair()
    server.start()

    openFn.mockImplementation(({ requestId }) => {
      setTimeout(() => dispatchPortMessage(requestId, client), 10)
      return Promise.resolve({ ok: true })
    })

    const openedClient = await getLspClient('worktree-1', 'typescript')
    expect(openedClient).toBeInstanceOf(LspPortClientClass)

    const closeSpy = vi.spyOn(requireClient(openedClient), 'close')

    resetLspClients()

    // Allow async cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(closeSpy).toHaveBeenCalled()
  })

  it('releasing the last lease closes and evicts the client; an earlier release keeps it', async () => {
    openFn.mockImplementation(({ requestId }) => {
      setTimeout(() => dispatchPortMessage(requestId, createPortPair().client), 10)
      return Promise.resolve({ ok: true })
    })
    retainLspClient('worktree-1', 'typescript')
    retainLspClient('worktree-1', 'typescript')
    const opened = requireClient(await getLspClient('worktree-1', 'typescript'))
    const closeSpy = vi.spyOn(opened, 'close')

    releaseLspClient('worktree-1', 'typescript')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closeSpy).not.toHaveBeenCalled()
    expect(await getLspClient('worktree-1', 'typescript')).toBe(opened)
    expect(openFn).toHaveBeenCalledTimes(1)

    releaseLspClient('worktree-1', 'typescript')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closeSpy).toHaveBeenCalledTimes(1)
    const reopened = await getLspClient('worktree-1', 'typescript')
    expect(reopened).not.toBe(opened)
    expect(openFn).toHaveBeenCalledTimes(2)
    reopened?.close()
  })

  it('releasing a lease on another language keeps this client', async () => {
    openFn.mockImplementation(({ requestId }) => {
      setTimeout(() => dispatchPortMessage(requestId, createPortPair().client), 10)
      return Promise.resolve({ ok: true })
    })
    retainLspClient('worktree-1', 'typescript')
    const opened = requireClient(await getLspClient('worktree-1', 'typescript'))
    const closeSpy = vi.spyOn(opened, 'close')
    retainLspClient('worktree-1', 'ruby')
    releaseLspClient('worktree-1', 'ruby')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closeSpy).not.toHaveBeenCalled()
    opened.close()
  })
})
