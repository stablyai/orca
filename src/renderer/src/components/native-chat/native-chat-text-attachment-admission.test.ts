import { afterEach, expect, it, vi } from 'vitest'
import {
  generateKeyPair,
  deriveSharedKey,
  decrypt,
  encrypt,
  publicKeyToBase64
} from '../../../../shared/e2ee-crypto'
import { AttachmentTextSource } from '../../../../shared/attachment-text-source'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from '../../web/web-preload-api-test-harness'

const store = vi.hoisted(() => ({ runtimeEnvironments: [{ id: 'attachment35636' }] }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
const path = '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/x.txt'
const bytes = Buffer.from('\ufeffcomplete\r\n🙂')
const host = {
  runtimeId: 'runtime35636',
  protocolVersion: 3,
  minCompatibleMobileVersion: 2,
  capabilities: ['native-chat.text-attachment-read.v1']
}
type Frame = { id: string; method: string; params?: { offset: number; length: number } }

async function fixture() {
  vi.resetModules()
  const keys = generateKeyPair()
  const frames: { socket: Socket; frame: Frame }[] = []
  const sockets: Socket[] = []
  let holdConnection: (() => void) | undefined
  let answer: (socket: Socket, frame: Frame) => void = (socket, frame) => socket.reply(frame)
  class Socket {
    static CONNECTING = 0
    static OPEN = 1
    readyState = 0
    binaryType = 'arraybuffer'
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    key?: Uint8Array
    runtimeId = host.runtimeId
    constructor(_url: string) {
      sockets.push(this)
      if (holdConnection) {
        const held = holdConnection
        holdConnection = undefined
        held()
        return
      }
      queueMicrotask(() => {
        if (this.readyState === 0) {
          this.readyState = 1
          this.onopen?.()
        }
      })
    }
    send(raw: string) {
      if (!this.key) {
        const hello = JSON.parse(raw)
        this.key = deriveSharedKey(keys.secretKey, Buffer.from(hello.publicKeyB64, 'base64'))
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) }))
        return
      }
      const frame = JSON.parse(decrypt(raw, this.key)!)
      if (frame.type === 'e2ee_auth') {
        queueMicrotask(() => this.deliver({ type: 'e2ee_authenticated' }))
      } else {
        frames.push({ socket: this, frame })
        answer(this, frame)
      }
    }
    deliver(value: unknown) {
      if (this.readyState === 1) {
        this.onmessage?.({ data: encrypt(JSON.stringify(value), this.key!) })
      }
    }
    reply(frame: Frame) {
      const part = bytes.subarray(
        frame.params?.offset ?? 0,
        (frame.params?.offset ?? 0) + (frame.params?.length ?? 0)
      )
      queueMicrotask(() =>
        this.deliver({
          id: frame.id,
          ok: true,
          result:
            frame.method === 'status.get'
              ? { ...host, runtimeId: this.runtimeId }
              : {
                  snapshot: 'a'.repeat(64),
                  size: bytes.length,
                  bytesRead: part.length,
                  eof: frame.params!.offset + part.length === bytes.length,
                  contentBase64: part.toString('base64')
                },
          _meta: { runtimeId: this.runtimeId }
        })
      )
    }
    close() {
      this.readyState = 3
    }
  }
  const globals = installBrowserGlobals()
  Object.assign(globals.window, { setTimeout, clearTimeout, setInterval, clearInterval })
  vi.stubGlobal('WebSocket', Socket)
  writeStoredRuntimeEnvironment(globals.storage, 'attachment35636')
  const stored = JSON.parse(globals.storage.getItem('orca.web.runtimeEnvironment.v1')!)
  stored.endpoints[0].publicKeyB64 = publicKeyToBase64(keys.publicKey)
  globals.storage.setItem('orca.web.runtimeEnvironment.v1', JSON.stringify(stored))
  const { createRuntimeEnvironmentsApi } =
    await import('../../web/preload-api/web-runtime-environments-api')
  const api = createRuntimeEnvironmentsApi()
  Object.assign(globals.window, { api: { runtimeEnvironments: api } })
  const session = await import('../../web/preload-api/web-runtime-session')
  const rpc = await import('@/runtime/runtime-rpc-client')
  const { createChatAttachmentReader } = await import('./native-chat-text-attachment-read')
  const reader = createChatAttachmentReader({
    kind: 'environment',
    environmentId: 'attachment35636'
  })
  cleanup = () => {
    session.closeActiveRuntimeClients()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
  return {
    api,
    session,
    rpc,
    reader,
    frames,
    sockets,
    createChatAttachmentReader,
    holdConnection: (fn: () => void) => {
      holdConnection = fn
    },
    answer: (fn: typeof answer) => {
      answer = fn
    }
  }
}
let cleanup = () => {}
afterEach(() => cleanup())

it.each(['status', 'compatibility', 'queue', 'child', 'connect', 'response'] as const)(
  'settles disposed %s work promptly and completes same-reader Retry through real web admission',
  async (stage) => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let held: { socket: (typeof f.sockets)[number]; frame: Frame } | undefined
    const bodies = () =>
      f.frames.filter(({ frame }) => frame.method === 'agentSessionAttachment.readTextChunk')
    const enqueue = f.session.runtimeCallQueuePool.enqueue.bind(f.session.runtimeCallQueuePool)
    const blockers: Promise<unknown>[] = []
    let intercepted = false
    if (stage === 'connect') {
      const subscribe = f.api.subscribe.bind(f.api)
      vi.spyOn(f.api, 'subscribe').mockImplementation((args, callbacks) => {
        if (args.method === 'agentSessionAttachment.readTextChunk' && !intercepted) {
          intercepted = true
          f.holdConnection(() => entered.resolve())
        }
        return subscribe(args, callbacks)
      })
    }
    if (stage === 'queue') {
      vi.spyOn(f.session.runtimeCallQueuePool, 'enqueue').mockImplementation(
        (selector, method, run, size, signal) => {
          if (method === 'agentSessionAttachment.readTextChunk' && !intercepted) {
            intercepted = true
            for (let index = 0; index < 8; index++) {
              blockers.push(enqueue(selector, 'pressure35636', () => release.promise))
            }
            const result = enqueue(selector, method, run, size, signal)
            entered.resolve()
            return result
          }
          return enqueue(selector, method, run, size, signal)
        }
      )
    }
    f.answer((socket, frame) => {
      const parent = socket === f.sockets[0]
      const shouldHold =
        !held &&
        (stage === 'status'
          ? frame.method === 'status.get' && !parent
          : stage === 'compatibility'
            ? frame.method === 'status.get' && parent
            : stage === 'child'
              ? frame.method === 'status.get' &&
                !parent &&
                bodies().length === 0 &&
                f.frames.filter(
                  (entry) => entry.frame.method === 'status.get' && entry.socket !== f.sockets[0]
                ).length === 2
              : stage === 'response'
                ? frame.method === 'agentSessionAttachment.readTextChunk'
                : false)
      if (shouldHold) {
        held = { socket, frame }
        entered.resolve()
      } else {
        socket.reply(frame)
      }
    })
    const old = new AttachmentTextSource(path, f.reader)
    const oldResult = old.copyText().catch((error) => error)
    await entered.promise
    if (stage === 'compatibility') {
      await vi.waitFor(() =>
        expect(f.sockets.slice(1).some((socket) => socket.readyState === 3)).toBe(true)
      )
    }
    const shared =
      stage === 'compatibility'
        ? f.rpc.ensureRuntimeEnvironmentCompatible('attachment35636')
        : Promise.resolve()
    const before = bodies().length
    old.dispose()
    expect((await oldResult).name).toBe('AbortError')
    const successor = new AttachmentTextSource(path, f.reader)
    const copied = successor.copyText()
    release.resolve()
    held?.socket.reply(held.frame)
    expect(await copied).toBe(bytes.toString('utf8'))
    await Promise.all(blockers)
    await shared
    expect(bodies()).toHaveLength(before + 2)
    successor.dispose()
  }
)

it('pins the actual sending child, rejects another runtime and settles a dropped response before legitimate Retry', async () => {
  const f = await fixture()
  f.answer((socket, frame) => {
    if (frame.method === 'status.get' && socket !== f.sockets[0]) {
      socket.runtimeId = 'wrong35636'
    }
    socket.reply(frame)
  })
  const responses = vi.fn()
  await expect(
    f.api.subscribe(
      {
        selector: 'attachment35636',
        method: 'agentSessionAttachment.readTextChunk',
        params: { path, offset: 0, length: 1 },
        expectedEnvironmentRuntimeId: host.runtimeId,
        timeoutMs: 1000
      },
      { onResponse: responses }
    )
  ).rejects.toThrow('Runtime connection changed')
  expect(
    f.frames.some(({ frame }) => frame.method === 'agentSessionAttachment.readTextChunk')
  ).toBe(false)
  expect(responses).not.toHaveBeenCalled()
  const entered = Promise.withResolvers<void>()
  f.answer((socket, frame) => {
    if (frame.method === 'agentSessionAttachment.readTextChunk') {
      entered.resolve()
    } else {
      socket.reply(frame)
    }
  })
  const abandoned = new AttachmentTextSource(path, f.reader)
  const failure = abandoned.copyText().catch((error) => error)
  await entered.promise
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(15_001)
  expect((await failure).message).toContain('Unable to read')
  vi.useRealTimers()
  f.answer((socket, frame) => socket.reply(frame))
  const successor = new AttachmentTextSource(path, f.reader)
  expect(await successor.copyText()).toBe(bytes.toString('utf8'))
  successor.dispose()
})

it('captures the virtual-local paired host rather than retargeting a later active server', async () => {
  const f = await fixture()
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  const read = f.createChatAttachmentReader({ kind: 'local' })
  store.runtimeEnvironments = [{ id: 'another35636' }]
  const source = new AttachmentTextSource(path, read)
  expect(await source.copyText()).toBe(bytes.toString('utf8'))
  source.dispose()
  store.runtimeEnvironments = [{ id: 'attachment35636' }]
})

it.each(['epoch', 'pairing'] as const)(
  'refuses %s changes after the actual child probe and before frame emission',
  async (kind) => {
    const f = await fixture()
    const { WebRuntimeConnectionTransport } =
      await import('../../web/web-runtime-connection-transport')
    const original = WebRuntimeConnectionTransport.prototype.waitForConnected
    const waits = new WeakMap<InstanceType<typeof WebRuntimeConnectionTransport>, number>()
    vi.spyOn(WebRuntimeConnectionTransport.prototype, 'waitForConnected').mockImplementation(
      function (this: InstanceType<typeof WebRuntimeConnectionTransport>, timeout) {
        const count = (waits.get(this) ?? 0) + 1
        waits.set(this, count)
        return original.call(this, timeout).then(() => {
          if (count === 2) {
            if (kind === 'epoch') {
              this.requestRegistry.connectionOpened()
            } else {
              f.session.webRuntimeState.activeEnvironment!.pairingRevision = 2
            }
          }
        })
      }
    )
    await expect(
      f.api.subscribe(
        {
          selector: 'attachment35636',
          method: 'agentSessionAttachment.readTextChunk',
          params: { path, offset: 0, length: 1 },
          expectedEnvironmentPairingRevision: 1,
          expectedEnvironmentRuntimeId: host.runtimeId,
          timeoutMs: 1000
        },
        { onResponse: vi.fn() }
      )
    ).rejects.toThrow(
      kind === 'epoch' ? 'Runtime connection changed' : 'paired Orca server changed'
    )
    expect(
      f.frames.some(({ frame }) => frame.method === 'agentSessionAttachment.readTextChunk')
    ).toBe(false)
  }
)

it('terminates an interrupted body without replay and lets a fresh source reconnect', async () => {
  const f = await fixture()
  const emitted = Promise.withResolvers<void>()
  f.answer((socket, frame) => {
    if (frame.method === 'agentSessionAttachment.readTextChunk') {
      emitted.resolve()
      queueMicrotask(() => {
        socket.readyState = 3
        socket.onclose?.()
      })
    } else {
      socket.reply(frame)
    }
  })
  const old = new AttachmentTextSource(path, f.reader)
  const pending = old.copyText().catch((error) => error)
  await emitted.promise
  expect((await pending).message).toContain('Unable to read')
  const before = f.frames.filter(
    ({ frame }) => frame.method === 'agentSessionAttachment.readTextChunk'
  ).length
  f.answer((socket, frame) => socket.reply(frame))
  const retry = new AttachmentTextSource(
    path,
    f.createChatAttachmentReader({ kind: 'environment', environmentId: 'attachment35636' })
  )
  expect(await retry.copyText()).toBe(bytes.toString('utf8'))
  expect(
    f.frames.filter(({ frame }) => frame.method === 'agentSessionAttachment.readTextChunk')
  ).toHaveLength(before + 2)
  retry.dispose()
})

it.each(['status', 'body'] as const)(
  'detaches an already admitted local %s waiter while its same-reader successor completes',
  async (phase) => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let held = false
    const calls: string[] = []
    Object.assign(window.api, {
      runtime: {
        call: async ({
          method,
          params
        }: {
          method: string
          params?: { offset: number; length: number }
        }) => {
          calls.push(method)
          if (!held && (method === 'status.get') === (phase === 'status')) {
            held = true
            entered.resolve()
            await release.promise
          }
          const part = bytes.subarray(
            params?.offset ?? 0,
            (params?.offset ?? 0) + (params?.length ?? 0)
          )
          return {
            id: 'local35636',
            ok: true,
            result:
              method === 'status.get'
                ? host
                : {
                    snapshot: 'a'.repeat(64),
                    size: bytes.length,
                    bytesRead: part.length,
                    contentBase64: part.toString('base64'),
                    eof: params!.offset + part.length === bytes.length
                  }
          }
        }
      }
    })
    const read = f.createChatAttachmentReader({ kind: 'local' })
    const old = new AttachmentTextSource(path, read)
    const failed = old.copyText().catch((error) => error)
    await entered.promise
    old.dispose()
    expect((await failed).name).toBe('AbortError')
    const retry = new AttachmentTextSource(path, read)
    expect(await retry.copyText()).toBe(bytes.toString('utf8'))
    const count = calls.length
    release.resolve()
    await Promise.resolve()
    expect(calls).toHaveLength(count)
    retry.dispose()
  }
)

it('bounds a dropped capability response and permits Retry after a real reconnect', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  f.answer((_socket, _frame) => entered.resolve())
  vi.useFakeTimers()
  const old = new AttachmentTextSource(path, f.reader)
  const failed = old.copyText().catch((error) => error)
  await entered.promise
  await vi.advanceTimersByTimeAsync(15_001)
  expect(await failed).toBeInstanceOf(Error)
  expect(f.frames.every(({ frame }) => frame.method === 'status.get')).toBe(true)
  f.answer((socket, frame) => socket.reply(frame))
  expect(await f.api.connect({ selector: 'attachment35636' })).toMatchObject({ ok: true })
  const retry = new AttachmentTextSource(path, f.reader)
  expect(await retry.copyText()).toBe(bytes.toString('utf8'))
  retry.dispose()
})
