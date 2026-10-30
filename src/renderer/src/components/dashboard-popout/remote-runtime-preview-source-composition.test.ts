// @vitest-environment happy-dom
import '../../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { OrcaRuntimeService } from '../../../../main/runtime/orca-runtime'
import { startDesktopMultiplexSubscribe } from '../../../../main/runtime/rpc/terminal-multiplex-test-harness'
import { decodeTerminalStreamFrame } from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from '../terminal-pane/remote-runtime-pty-transport-test-harness'
import { installPreviewTerminalLinks } from './preview-terminal-links'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('./preview-terminal-link-context', () => ({
  previewTerminalLinkContext: () => ({
    worktreeId: '',
    worktreePath: '',
    sourceOwner: { kind: 'local' }
  })
}))
let callbacks: MultiplexSubscriptionCallbacks = null
let handle = ''
const mocks = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (value) => {
    callbacks = value
  },
  getResolvedPaneHandle: () => handle,
  setResolvedPaneHandle: (value) => {
    handle = value
  }
})
const hosts: ReturnType<typeof startDesktopMultiplexSubscribe>[] = []
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    await dispose()
  }
  for (const host of hosts.splice(0)) {
    host.registry.cleanupSubscriptionsForConnection('conn-desktop-first-paint')
    await host.dispatchPromise
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('fences a host-produced valid direct-alias replacement before snapshot, with a stale-alias producer control', async () => {
  mocks.resetRemoteRuntimeTransport()
  const writes: { id: string; data: string }[] = []
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    write: (id, data) => {
      writes.push({ id, data })
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const id = 'ssh:target@@preview-source'
  const tabId = 'source-tab'
  const leafId = '11111111-1111-4111-8111-111111111111'
  handle = runtime.preAllocateHandleForPty(id)
  const register = (incarnationId: string, preserve: boolean): void => {
    runtime.registerPty(id, '/workspace', 'target', {
      tabId,
      leafId,
      incarnationId,
      ...(preserve ? { terminalHandle: handle } : {})
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId, worktreeId: '/workspace', title: 'Terminal', activeLeafId: leafId, layout: null }
      ],
      leaves: [{ tabId, worktreeId: '/workspace', leafId, paneRuntimeId: 1, ptyId: id }]
    })
  }
  runtime.attachWindow(1)
  register('i1', false)
  let releaseSnapshot = (): void => {}
  let snapshots = 0
  mocks.runtimeSubscribe.mockImplementation(
    async (_args: unknown, next: NonNullable<MultiplexSubscriptionCallbacks>) => {
      callbacks = next
      const host = startDesktopMultiplexSubscribe(
        {
          resolveLiveLeafForHandle: runtime.resolveLiveLeafForHandle.bind(runtime),
          getPtyExecutionHostMetadata: runtime.getPtyExecutionHostMetadata.bind(runtime),
          getTerminalLaunchResult: runtime.getTerminalLaunchResult.bind(runtime),
          readTerminal: runtime.readTerminal.bind(runtime),
          sendTerminal: runtime.sendTerminal.bind(runtime),
          serializeTerminalBuffer: async () => {
            snapshots++
            if (snapshots === 2) {
              await new Promise<void>((resolve) => {
                releaseSnapshot = resolve
              })
            }
            return { data: 'screen', cols: 80, rows: 24 }
          }
        },
        undefined,
        (bytes) => {
          next.onBinary?.(bytes)
        },
        (message) => {
          const response = JSON.parse(message)
          if (response.result?.type === 'ready') {
            queueMicrotask(() => next.onResponse(response))
          } else {
            next.onResponse(response)
          }
        }
      )
      hosts.push(host)
      return {
        unsubscribe: () =>
          host.registry.cleanupSubscriptionsForConnection('conn-desktop-first-paint'),
        sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
          const frame = decodeTerminalStreamFrame(bytes)
          if (!frame) {
            throw new Error('invalid production frame')
          }
          host.handlers.get(frame.streamId)?.(frame)
        }
      }
    }
  )
  const { bindRemoteRuntimeTerminalPreview } = await import('./remote-runtime-terminal-preview-api')
  const previewId = `remote:env-1@@${handle}`
  const binding = bindRemoteRuntimeTerminalPreview(previewId)
  cleanup.push(() => binding.unsubscribe(previewId))
  await binding.connect(previewId)
  const original = binding.getInputSource()
  if (!original) {
    throw new Error('missing original source')
  }

  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () => new DOMRect(0, 0, 800, 240)
  element.append(screen)
  document.body.append(element)
  const emulator = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const url = 'https://example.test/source'
  const options: Terminal['options'] = {}
  const request = vi.fn()
  const terminal = {
    element,
    buffer: emulator.buffer,
    cols: 80,
    rows: 24,
    options,
    _core: {
      linkifier: {
        _currentLink: {
          link: { text: url, range: { start: { x: 1, y: 1 }, end: { x: 40, y: 1 } } }
        }
      }
    },
    hasSelection: () => false,
    clearSelection: vi.fn(),
    focus: vi.fn(),
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() }))
  }
  const links = installPreviewTerminalLinks(terminal, {
    getSettings: () => ({ terminalLinkClickBehavior: 'actions' }),
    linkRouting: {
      request,
      getContext: () => ({ worktreeId: '', worktreePath: '', sourceOwner: { kind: 'local' } })
    }
  })
  const owner = links.inputOwner
  const observation = binding.observeInputSource({
    beforeChange: owner.invalidateSource,
    afterChange: (source) => {
      const forward = (data: string): void => {
        source?.sendInput(data, 'driving')
      }
      owner.bindSource(
        source && { isCurrent: source.isCurrent, user: forward, unclassified: forward }
      )
    }
  })
  cleanup.push(() => {
    try {
      links()
    } finally {
      observation.dispose()
      emulator.dispose()
      element.remove()
    }
  })
  const ordinary = (data: string): void => {
    void binding.input(previewId, data)
  }
  const down = '\x1b[<0;1;1M'
  const up = '\x1b[<0;1;1m'
  element.addEventListener('mousedown', () => owner.handlePtyInput(down, ordinary, true))
  element.addEventListener('mouseup', (event) => {
    owner.handlePtyInput(up, ordinary, true)
    options.linkHandler?.activate(event, url, { start: { x: 1, y: 1 }, end: { x: 40, y: 1 } })
  })
  const press = (type: string): void => {
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        buttons: type === 'mousedown' ? 1 : 0,
        clientX: 5,
        clientY: 5
      })
    )
  }
  callbacks?.onError?.({ code: 'remote_runtime_unavailable', message: 'closed' })
  register('i2', true)
  await expect(runtime.readTerminal(handle)).resolves.toMatchObject({ status: 'running' })
  expect(runtime.getTerminalLaunchResult(id)).toMatchObject({ incarnationId: 'i2' })
  const recovering = binding.connect(previewId)
  await vi.waitFor(() => expect(snapshots).toBe(2))
  expect(binding.getInputSource()).toBe(original)
  press('mousedown')
  expect(writes).toEqual([])
  releaseSnapshot()
  await recovering
  expect(original.isCurrent()).toBe(false)
  press('mouseup')
  expect(request).not.toHaveBeenCalled()
  expect(writes).toEqual([])
  await new Promise((resolve) => setTimeout(resolve, 0))
  press('mousedown')
  press('mouseup')
  expect(request).toHaveBeenCalledOnce()
  expect(writes).toEqual([])
  press('mousedown')
  owner.reset()
  press('mouseup')
  await binding.input(previewId, 'ordinary-i2')
  await vi.waitFor(() =>
    expect(writes.map((entry) => entry.data)).toEqual([down, up, 'ordinary-i2'])
  )
  expect(writes.every((entry) => entry.id === id)).toBe(true)

  // The actual producer refuses an invalidated alias rather than issuing another ACK for it.
  callbacks?.onError?.({ code: 'remote_runtime_unavailable', message: 'closed' })
  register('i3', false)
  const stale = binding.connect(previewId)
  await expect(stale).resolves.toEqual({ snapshot: null, replay: [] })
  await expect(runtime.readTerminal(handle)).rejects.toThrow('terminal_handle_stale')
  expect(writes.map((entry) => entry.data)).toEqual([down, up, 'ordinary-i2'])
})
