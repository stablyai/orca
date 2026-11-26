import { describe, expect, it, vi } from 'vitest'
import {
  callbacks,
  createTauriPtyApi,
  callRuntimeResult,
  callTauriPtyHost,
  requireActiveEnvironment,
  spawn,
  stream,
  subscribeTerminal
} from './web-tauri-pty-test-fixture'

describe('Tauri PTY preload API', () => {
  it('negotiates a stable input session when subscribing to a terminal', async () => {
    const result = await spawn(true, { tabId: 'tab-1', leafId: 'leaf-1' })

    expect(result.id).toBe('remote:env-1@@terminal-1')
    expect(subscribeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: 'terminal-1',
        inputSessionId: expect.any(String)
      })
    )
  })

  it('keeps the renderer cwd and viewport when creating a terminal', async () => {
    await spawn(true, { cwd: 'C:/repo/packages/app', worktreeId: 'worktree-1' })

    expect(callRuntimeResult).toHaveBeenCalledWith(
      'terminal.create',
      expect.objectContaining({
        worktree: 'worktree-1',
        cwd: 'C:/repo/packages/app',
        cols: 80,
        rows: 24
      })
    )
  })

  it('sends acknowledged input with a sequence and settles writeAccepted from the host ack', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(true)

    const settled = api.writeAccepted(result.id, 'echo ok\r', 'driving')
    await Promise.resolve()
    expect(stream.sent).toEqual([{ text: 'echo ok\r', seq: 1 }])

    callbacks.onInputAck?.(1, 'applied')
    await expect(settled).resolves.toBe(true)
  })

  it('reuses the input session when a pane is reattached with a replacement handle', async () => {
    const api = createTauriPtyApi()
    const first = await spawn(
      true,
      { tabId: 'tab-reattach', leafId: 'leaf-1' },
      'terminal-reattach'
    )
    const firstStream = stream
    api.write(first.id, 'echo pending\r', 'driving')
    expect(firstStream.sent).toEqual([{ text: 'echo pending\r', seq: 1 }])
    const firstSessionId = subscribeTerminal.mock.calls.at(-1)?.[0].inputSessionId

    await spawn(true, { tabId: 'tab-reattach', leafId: 'leaf-1' }, 'terminal-reattach')
    const secondSessionId = subscribeTerminal.mock.calls.at(-1)?.[0].inputSessionId

    expect(secondSessionId).toBe(firstSessionId)
    expect(stream.sent).toEqual([{ text: 'echo pending\r', seq: 1 }])
  })

  it('uses the legacy unsequenced stream write when the host does not negotiate input acks', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)

    await expect(api.writeAccepted(result.id, 'echo legacy\r', 'driving')).resolves.toBe(true)
    expect(stream.sent).toEqual([{ text: 'echo legacy\r' }])
  })

  it('forwards output metadata and supplies a raw length for legacy streams', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    const onData = vi.fn()
    const unsubscribe = api.onData(onData)

    callbacks.onData?.('hello', { seq: 7, rawLength: 9, transformed: true })
    callbacks.onData?.('ok')

    expect(onData).toHaveBeenNthCalledWith(1, {
      id: result.id,
      data: 'hello',
      seq: 7,
      rawLength: 9,
      transformed: true
    })
    expect(onData).toHaveBeenNthCalledWith(2, {
      id: result.id,
      data: 'ok',
      rawLength: 2
    })
    unsubscribe()
  })

  it('preserves the renderer binding when the runtime transport closes', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    const onExit = vi.fn()
    const unsubscribe = api.onExit(onExit)

    callbacks.onTransportClose?.({ recoverable: true, retryWithBackoff: true })

    expect(onExit).toHaveBeenCalledWith({
      id: result.id,
      code: 1,
      preserveRendererBinding: true
    })
    await expect(api.getCwd(result.id)).resolves.toBe('')
    unsubscribe()
  })

  it.each([
    ['a host-reported status', 42, 42],
    ['a legacy bare end', undefined, 0]
  ])('forwards %s as exit code %s', async (_case, exitCode, expected) => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    const onExit = vi.fn()
    const unsubscribe = api.onExit(onExit)
    try {
      callbacks.onEnd?.('exited', exitCode)
      expect(onExit).toHaveBeenCalledExactlyOnceWith({ id: result.id, code: expected })
    } finally {
      unsubscribe()
    }
  })

  it('removes a killed PTY after the runtime closes it', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    requireActiveEnvironment.mockReturnValue({ id: 'env-2' })

    await api.kill(result.id)
    expect(stream.close).toHaveBeenCalledOnce()
    expect(callTauriPtyHost).toHaveBeenLastCalledWith(result.id, 'terminal.close', {
      terminal: 'terminal-1'
    })
    await expect(api.getCwd(result.id)).resolves.toBe('')
  })

  it('keeps the host history when a pane is hibernated', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    requireActiveEnvironment.mockReturnValue({ id: 'env-2' })
    callTauriPtyHost.mockResolvedValueOnce({
      stoppedPtyIds: ['pty-terminal-1'],
      livePtyIds: ['pty-terminal-1', 'another-pty'],
      postStopVerified: true
    })

    await api.kill(result.id, { keepHistory: true })

    expect(callTauriPtyHost).toHaveBeenLastCalledWith(result.id, 'terminal.stopExact', {
      worktree: 'C:/repo',
      expectedPtyIds: ['pty-terminal-1'],
      keepHistory: true,
      targetOnly: true
    })
    expect(stream.close).toHaveBeenCalledOnce()
    await expect(api.getSize(result.id)).resolves.toBeNull()
  })

  it.each([undefined, ''])(
    'does not delete history when the host omits ptyId (%s)',
    async (ptyId) => {
      const api = createTauriPtyApi()
      const result = await spawn(false, {}, undefined, { ptyId })

      await expect(api.kill(result.id, { keepHistory: true })).rejects.toThrow(
        'terminal_exact_stop_unavailable'
      )
      expect(callRuntimeResult).toHaveBeenCalledTimes(1)
      expect(callTauriPtyHost).not.toHaveBeenCalled()
      expect(stream.close).not.toHaveBeenCalled()
      await expect(api.getSize(result.id)).resolves.toEqual({ cols: 80, rows: 24 })
    }
  )

  it.each([false, true])(
    'keeps the binding if host stop fails (keepHistory=%s)',
    async (keepHistory) => {
      const api = createTauriPtyApi()
      const result = await spawn(false)
      callTauriPtyHost.mockRejectedValueOnce(new Error('host_unreachable'))

      await expect(api.kill(result.id, { keepHistory })).rejects.toThrow('host_unreachable')
      expect(stream.close).not.toHaveBeenCalled()
      await expect(api.writeAccepted(result.id, 'echo retry\r', 'driving')).resolves.toBe(true)
    }
  )

  it.each([
    { stoppedPtyIds: ['different-pty'], livePtyIds: ['pty-terminal-1'], postStopVerified: true },
    { stoppedPtyIds: ['pty-terminal-1'], livePtyIds: [], postStopVerified: true },
    {
      stoppedPtyIds: ['pty-terminal-1', 'extra-pty'],
      livePtyIds: ['pty-terminal-1'],
      postStopVerified: true
    }
  ])('rejects an exact-stop identity mismatch: %j', async (response) => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    callTauriPtyHost.mockResolvedValueOnce(response)

    await expect(api.kill(result.id, { keepHistory: true })).rejects.toThrow(
      'exact_terminal_stop_mismatch'
    )
    expect(stream.close).not.toHaveBeenCalled()
  })

  it.each([false, undefined])(
    'rejects an unverifiable host stop (%s)',
    async (postStopVerified) => {
      const api = createTauriPtyApi()
      const result = await spawn(false)
      callTauriPtyHost.mockResolvedValueOnce({
        stoppedPtyIds: ['pty-terminal-1'],
        livePtyIds: ['pty-terminal-1'],
        postStopVerified
      })

      await expect(api.kill(result.id, { keepHistory: true })).rejects.toThrow(
        'exact_terminal_stop_unverified'
      )
      expect(stream.close).not.toHaveBeenCalled()
    }
  )

  it('does not detach a replacement binding after the old host stop completes', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    let finishClose: (() => void) | undefined
    callTauriPtyHost.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve
        })
    )
    const closing = api.kill(result.id)
    await spawn(false, {}, 'terminal-1')
    const replacementStream = stream

    finishClose?.()
    await closing

    expect(replacementStream.close).not.toHaveBeenCalled()
    await expect(api.getSize(result.id)).resolves.toEqual({ cols: 80, rows: 24 })
  })

  it('routes terminal controls to the bound owner after switching environments', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    requireActiveEnvironment.mockReturnValue({ id: 'env-2' })
    callTauriPtyHost.mockResolvedValueOnce({
      signal: { handle: 'terminal-1', signaled: true }
    })
    api.signal(result.id, 'SIGINT')
    api.clearBuffer(result.id)
    api.resetInputModes(result.id)
    await vi.waitFor(() =>
      expect(callTauriPtyHost.mock.calls).toEqual([
        [result.id, 'terminal.signal', { terminal: 'terminal-1', signal: 'SIGINT' }],
        [result.id, 'terminal.clearBuffer', { terminal: 'terminal-1' }],
        [result.id, 'terminal.resetInputModes', { terminal: 'terminal-1' }]
      ])
    )
  })

  it('delivers SIGINT through the true signal path without the legacy interrupt write', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    callTauriPtyHost.mockResolvedValueOnce({
      signal: { handle: 'terminal-1', signaled: true }
    })

    api.signal(result.id, 'SIGINT')
    await vi.waitFor(() =>
      expect(callTauriPtyHost).toHaveBeenCalledWith(result.id, 'terminal.signal', {
        terminal: 'terminal-1',
        signal: 'SIGINT'
      })
    )
    await Promise.resolve()
    expect(callTauriPtyHost).toHaveBeenCalledTimes(1)
  })

  it('falls back to the legacy interrupt write when the host reports signaled false', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    callTauriPtyHost.mockResolvedValueOnce({
      signal: { handle: 'terminal-1', signaled: false }
    })

    api.signal(result.id, 'SIGINT')
    await vi.waitFor(() =>
      expect(callTauriPtyHost).toHaveBeenCalledWith(result.id, 'terminal.send', {
        terminal: 'terminal-1',
        interrupt: true
      })
    )
  })

  it('falls back to the legacy interrupt write when the signal call rejects', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    callTauriPtyHost.mockRejectedValueOnce(new Error('terminal.signal unknown'))

    api.signal(result.id, 'SIGINT')
    await vi.waitFor(() =>
      expect(callTauriPtyHost).toHaveBeenCalledWith(result.id, 'terminal.send', {
        terminal: 'terminal-1',
        interrupt: true
      })
    )
  })
})
