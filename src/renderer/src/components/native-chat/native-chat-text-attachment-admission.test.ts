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
    reader,
    frames,
    sockets,
    answer: (fn: typeof answer) => {
      answer = fn
    }
  }
}
let cleanup = () => {}
afterEach(() => cleanup())

it('cancels a pending real web capability read and completes a same-reader successor', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  let held: { socket: (typeof f.sockets)[number]; frame: Frame } | undefined
  f.answer((socket, frame) => {
    if (!held && frame.method === 'status.get' && socket !== f.sockets[0]) {
      held = { socket, frame }
      entered.resolve()
    } else {
      socket.reply(frame)
    }
  })
  const old = new AttachmentTextSource(path, f.reader)
  const result = old.copyText().catch((error) => error)
  await entered.promise
  old.dispose()
  expect((await result).name).toBe('AbortError')
  expect(
    f.frames.some(({ frame }) => frame.method === 'agentSessionAttachment.readTextChunk')
  ).toBe(false)
  const successor = new AttachmentTextSource(path, f.reader)
  const copied = successor.copyText()
  held!.socket.reply(held!.frame)
  expect(await copied).toBe(bytes.toString('utf8'))
  expect(
    f.frames.filter(({ frame }) => frame.method === 'agentSessionAttachment.readTextChunk')
  ).toHaveLength(2)
  successor.dispose()
})
