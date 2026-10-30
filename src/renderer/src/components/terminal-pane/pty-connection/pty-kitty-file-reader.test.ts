import { Terminal } from '@xterm/xterm'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readTerminalKittyFile } from '@/lib/pane-manager/terminal-kitty-file-reader'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { installPtyKittyFileReader } from './pty-kitty-file-reader'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), revision: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: mocks.revision
}))
const cleanups: (() => void)[] = []
function fixture(environmentId: string | null = null) {
  const terminal = new Terminal()
  let ptyId: string | null =
    environmentId === null
      ? 'pty-1'
      : toRemoteRuntimePtyId('term_11111111-1111-4111-8111-111111111111', environmentId)
  const bag = {
    pane: { terminal, leafId: 'leaf-1' },
    transport: { getPtyId: () => ptyId },
    deps: {
      worktreeId: 'folder-1',
      tabId: environmentId === null ? 'tab-1' : 'web-terminal-tab-1'
    },
    cacheKey: environmentId === null ? 'tab-1:leaf-1' : 'web-terminal-tab-1:leaf-1',
    runtimeEnvironmentId: environmentId,
    disposed: false,
    terminalOwnerUnresolved: false,
    cleanupKittyFileReader: () => undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every session member the reader accesses; no pane or manager operation is called.
  const session = bag as unknown as ConnectPanePtySession
  installPtyKittyFileReader(session)
  cleanups.push(() => {
    session.cleanupKittyFileReader()
    terminal.dispose()
  })
  return {
    session,
    terminal,
    setPtyId: (value: string | null) => {
      ptyId = value
    }
  }
}
function resolved(ptyId = 'pty-1', incarnationId: string | null = 'incarnation-1') {
  return {
    terminal: {
      ptyId,
      ...(incarnationId ? { incarnationId } : {}),
      handle: 'term_11111111-1111-4111-8111-111111111111'
    }
  }
}
function request() {
  return {
    path: '/execution-host/image.png',
    offset: 10,
    length: 12,
    signal: new AbortController().signal
  }
}
function deferred() {
  let resolve: (value: unknown) => void = () => undefined
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.revision.mockReset().mockReturnValue(7)
})
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
describe('PTY Kitty file execution-host routing', () => {
  it('resolves an encoded split surface using its parent tab and active leaf', async () => {
    const value = fixture('ssh-host')
    value.session.deps.tabId = 'web-terminal-tab-1%3A%3Aleaf-1'
    value.session.cacheKey = `${value.session.deps.tabId}:leaf-1`
    mocks.rpc.mockResolvedValueOnce(resolved()).mockResolvedValueOnce({ base64: 'AQID' })
    await readTerminalKittyFile(value.terminal, request())
    expect(mocks.rpc.mock.calls[0][2]).toEqual({ paneKey: 'tab-1:leaf-1', worktreeId: 'folder-1' })
    expect(mocks.rpc.mock.calls[1][2].terminal).toBe(resolved().terminal.handle)
  })

  it.each([null, 'ssh-host', 'wsl-environment'])(
    'uses owning runtime %s and host-normalized pane keys for both RPCs',
    async (environmentId) => {
      const value = fixture(environmentId)
      mocks.rpc.mockResolvedValueOnce(resolved()).mockResolvedValueOnce({ base64: 'AQID' })
      await expect(readTerminalKittyFile(value.terminal, request())).resolves.toEqual(
        new Uint8Array([1, 2, 3])
      )
      const target =
        environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
      expect(mocks.rpc).toHaveBeenNthCalledWith(
        1,
        target,
        'terminal.resolvePane',
        { paneKey: 'tab-1:leaf-1', worktreeId: 'folder-1' },
        expect.objectContaining({ timeoutMs: 5000, suppressFeatureInteraction: true })
      )
      expect(mocks.rpc).toHaveBeenNthCalledWith(
        2,
        target,
        'terminal.readKittyFile',
        {
          terminal: resolved().terminal.handle,
          path: '/execution-host/image.png',
          expectedIncarnationId: 'incarnation-1',
          offset: 10,
          length: 12
        },
        expect.objectContaining({ timeoutMs: 5000, suppressFeatureInteraction: true })
      )
    }
  )
  it('captures the pairing revision once before resolution and fences both RPCs with it', async () => {
    const value = fixture('remote-host')
    const pending = deferred()
    mocks.rpc.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ base64: 'AQ==' })
    const read = readTerminalKittyFile(value.terminal, request())
    expect(mocks.revision).toHaveBeenCalledOnce()
    expect(mocks.revision).toHaveBeenCalledWith('remote-host')
    mocks.revision.mockReturnValue(8)
    pending.resolve(resolved())
    await read
    expect(mocks.revision).toHaveBeenCalledOnce()
    expect(mocks.rpc.mock.calls[0][3].expectedEnvironmentPairingRevision).toBe(7)
    expect(mocks.rpc.mock.calls[1][3].expectedEnvironmentPairingRevision).toBe(7)
    expect(mocks.rpc.mock.calls[1][3]).toBe(mocks.rpc.mock.calls[0][3])
  })
  it('does not capture a remote revision for a local terminal', async () => {
    const value = fixture()
    mocks.rpc.mockResolvedValueOnce(resolved()).mockResolvedValueOnce({ base64: 'AQ==' })
    await readTerminalKittyFile(value.terminal, request())
    expect(mocks.revision).not.toHaveBeenCalled()
    expect(mocks.rpc.mock.calls[1][3].expectedEnvironmentPairingRevision).toBeUndefined()
  })
  it('omits incarnation and length for older runtime responses', async () => {
    const value = fixture('old-host')
    mocks.rpc
      .mockResolvedValueOnce(resolved('pty-1', null))
      .mockResolvedValueOnce({ base64: 'AQ==' })
    await readTerminalKittyFile(value.terminal, {
      path: '/execution-host/image.png',
      offset: 0,
      signal: new AbortController().signal
    })
    expect(mocks.rpc.mock.calls[1][2]).not.toHaveProperty('expectedIncarnationId')
    expect(mocks.rpc.mock.calls[1][2]).not.toHaveProperty('length')
  })
  it.each(['disconnected', 'disposed', 'unresolved'])(
    'refuses %s owner before RPC',
    async (state) => {
      const value = fixture('remote-host')
      if (state === 'disconnected') {
        value.setPtyId(null)
      }
      if (state === 'disposed') {
        value.session.disposed = true
      }
      if (state === 'unresolved') {
        value.session.terminalOwnerUnresolved = true
      }
      await expect(readTerminalKittyFile(value.terminal, request())).rejects.toThrow('unavailable')
      expect(mocks.rpc).not.toHaveBeenCalled()
    }
  )
  it('refuses a resolved terminal belonging to another native PTY', async () => {
    const value = fixture()
    mocks.rpc.mockResolvedValueOnce(resolved('other-pty'))
    await expect(readTerminalKittyFile(value.terminal, request())).rejects.toThrow(
      'binding changed'
    )
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
  it('refuses a foreign remote terminal handle despite a matching native PTY ID', async () => {
    const value = fixture('remote-host')
    mocks.rpc.mockResolvedValueOnce({
      terminal: { ...resolved().terminal, handle: 'term_22222222-2222-4222-8222-222222222222' }
    })
    await expect(readTerminalKittyFile(value.terminal, request())).rejects.toThrow(
      'binding changed'
    )
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
  it('refuses a remote handle owned by another environment', async () => {
    const value = fixture('remote-host')
    value.setPtyId(toRemoteRuntimePtyId(resolved().terminal.handle, 'different-host'))
    mocks.rpc.mockResolvedValueOnce(resolved())
    await expect(readTerminalKittyFile(value.terminal, request())).rejects.toThrow(
      'binding changed'
    )
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
  it('refuses a remote terminal with no live native PTY', async () => {
    const value = fixture('remote-host')
    mocks.rpc.mockResolvedValueOnce(resolved(''))
    await expect(readTerminalKittyFile(value.terminal, request())).rejects.toThrow(
      'binding changed'
    )
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
  it('refuses owner replacement during resolution', async () => {
    const value = fixture('remote-host')
    const pending = deferred()
    mocks.rpc.mockReturnValueOnce(pending.promise)
    const read = readTerminalKittyFile(value.terminal, request())
    value.setPtyId('replacement-pty')
    pending.resolve(resolved())
    await expect(read).rejects.toThrow('binding changed')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
  it('refuses owner replacement during file read', async () => {
    const value = fixture('remote-host')
    const pending = deferred()
    mocks.rpc.mockResolvedValueOnce(resolved()).mockReturnValueOnce(pending.promise)
    const read = readTerminalKittyFile(value.terminal, request())
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))
    value.setPtyId('replacement-pty')
    pending.resolve({ base64: 'AQ==' })
    await expect(read).rejects.toThrow('binding changed')
  })
  it.each(['resolve', 'read'])('aborts pending %s on disposal', async (stage) => {
    const value = fixture('remote-host')
    const pending = deferred()
    if (stage === 'read') {
      mocks.rpc.mockResolvedValueOnce(resolved())
    }
    mocks.rpc.mockReturnValueOnce(pending.promise)
    const read = readTerminalKittyFile(value.terminal, request())
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    if (stage === 'read') {
      await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))
    }
    value.session.cleanupKittyFileReader()
    await rejected
    pending.resolve(stage === 'read' ? { base64: 'AQ==' } : resolved())
    await expect(readTerminalKittyFile(value.terminal, request())).rejects.toThrow('unavailable')
  })
  it('passes cancellation to active host request', async () => {
    const value = fixture('remote-host')
    const pending = deferred()
    const controller = new AbortController()
    mocks.rpc.mockResolvedValueOnce(resolved()).mockReturnValueOnce(pending.promise)
    const read = readTerminalKittyFile(value.terminal, { ...request(), signal: controller.signal })
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))
    controller.abort()
    await rejected
    expect(mocks.rpc.mock.calls[1][3].signal.aborted).toBe(true)
    pending.resolve({ base64: 'AQ==' })
  })
  it('does not fall back locally when remote lacks RPC', async () => {
    const value = fixture('old-host')
    mocks.rpc
      .mockResolvedValueOnce(resolved())
      .mockRejectedValueOnce(new Error('Unknown method terminal.readKittyFile'))
    await expect(readTerminalKittyFile(value.terminal, request())).rejects.toThrow('Unknown method')
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(mocks.rpc.mock.calls.every((call) => call[0].kind === 'environment')).toBe(true)
  })
  it.each([null, '***', 'A'.repeat(2_796_205)])(
    'rejects malformed or oversized encoded response %#',
    async (base64) => {
      const value = fixture('remote-host')
      mocks.rpc.mockResolvedValueOnce(resolved()).mockResolvedValueOnce({ base64 })
      await expect(readTerminalKittyFile(value.terminal, request())).rejects.toThrow()
    }
  )
  it('rejects decoded bytes above 2 MiB at encoded boundary', async () => {
    const value = fixture('remote-host')
    mocks.rpc
      .mockResolvedValueOnce(resolved())
      .mockResolvedValueOnce({ base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') })
    const outcome = await readTerminalKittyFile(value.terminal, request()).then(
      (bytes) => ({ status: 'resolved', size: bytes.byteLength }),
      (error: unknown) => ({
        status: 'rejected',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    expect(outcome).toMatchObject({ status: 'rejected', message: expect.stringContaining('limit') })
  })
})
