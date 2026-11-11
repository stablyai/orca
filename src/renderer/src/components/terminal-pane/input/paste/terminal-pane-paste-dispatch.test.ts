import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeferred,
  flushAsyncTicks
} from '../../pty-connection/test-fixtures/pty-connection-test-async'
import {
  installIpcPtyWindow,
  restorePtySpecWindow
} from '../../pty-transport/ipc/pty-transport-test-harness'
import { pasteTextIntoTerminalPane } from './terminal-pane-paste-dispatch'

describe('pasteTextIntoTerminalPane into a starting terminal', () => {
  const originalWindow = globalThis.window

  beforeEach(() => {
    vi.resetModules()
    installIpcPtyWindow(originalWindow, {})
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  async function pasteBeforeConnect(text: string): Promise<{ status: string; written: string }> {
    const spawn = createDeferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise)
    const written: string[] = []
    vi.mocked(window.api.pty.write).mockImplementation((_id, data) => {
      written.push(data)
    })
    vi.mocked(window.api.pty.writeAccepted).mockImplementation(async (_id, data) => {
      written.push(data)
      return true
    })
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })
    const connecting = transport.connect({ url: '', callbacks: {} })
    const terminal = {
      modes: { bracketedPasteMode: false },
      options: {},
      paste: (data: string) => {
        transport.sendInput(data, 'driving')
      },
      input: (data: string) => {
        transport.sendInput(data, 'driving')
      }
    }

    const result = await pasteTextIntoTerminalPane({
      pane: { id: 1, leafId: 'leaf-1', terminal },
      text,
      source: 'keyboard',
      ptyId: null,
      runtime: { kind: 'local', platform: 'darwin', runtimeKey: 'local:darwin' },
      transport,
      inputKind: 'driving',
      isTargetCurrent: () => true,
      canContinue: () => true
    })
    transport.sendInput('\r', 'driving')
    spawn.resolve({ id: 'pty-1' })
    await connecting
    await flushAsyncTicks()
    return { status: result.status, written: written.join('') }
  }

  it('holds a pasted line break as pasted text, so only the user’s own Enter submits', async () => {
    await expect(pasteBeforeConnect('echo hi\n')).resolves.toEqual({
      status: 'pasted',
      written: '\x1b[200~echo hi\r\x1b[201~\r'
    })
  })

  it('refuses a paste too large for one held entry before writing any of it', async () => {
    await expect(pasteBeforeConnect('x'.repeat(70_000))).resolves.toEqual({
      status: 'rejected',
      written: '\r'
    })
  })
})
