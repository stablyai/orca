import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installIpcPtyWindow,
  restorePtySpecWindow,
  flushPtySideEffects
} from './pty-transport-test-harness'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      ptyProcessMetadataById: {},
      ptyProcessObservationRevision: 0,
      tabsByWorktree: {}
    }))
  }
})

describe('IPC process description lifetime', () => {
  const originalWindow = globalThis.window
  let data: ((payload: { id: string; data: string }) => void) | undefined
  let exit:
    | ((payload: {
        id: string
        code: number
        incarnationId?: string
        ptySourceDisowned?: boolean
      }) => void)
    | undefined
  beforeEach(async () => {
    data = undefined
    exit = undefined
    vi.resetModules()
    const { useAppStore } = await import('@/store')
    useAppStore.setState({ ptyProcessMetadataById: {}, ptyProcessObservationRevision: 0 })
    const { installPtyProcessExitObserver } = await import('./pty-process-observation')
    const { observeTerminalProcessExit } =
      await import('@/store/terminals/terminal-process-metadata')
    installPtyProcessExitObserver((event) =>
      useAppStore.setState((state) =>
        observeTerminalProcessExit(state, event.id, event.incarnationId)
      )
    )
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        data = callback
      },
      exit: (callback) => {
        exit = callback
      }
    })
  })
  afterEach(() => restorePtySpecWindow(originalWindow))

  it.each([100, 1000])('bounds inventory copy work and publication at %i rows', async (size) => {
    const { listActivationPtySessions } = await import('@/lib/worktree-activation-pty-inventory')
    const { captureLocalPtyProcessDescription, createIpcPtyProcessDescription } =
      await import('./ipc-pty-process-description')
    const { useAppStore } = await import('@/store')
    const { terminalProcessMetadataKey } =
      await import('@/store/terminals/terminal-process-metadata')
    const rows: PtyListedSession[] = Array.from({ length: size }, (_, i) => ({
      id: `live-${i}`,
      incarnationId: `inc-${i}`,
      shellPath: 'powershell.exe',
      wslDistro: null,
      cwd: '',
      title: '',
      agentOwnership: 'unknown'
    }))
    const retained = Object.fromEntries(
      rows.map((_, i) => [
        terminalProcessMetadataKey(i % 2 ? 'ssh:other' : 'local', `retained-${i}`),
        { observationRevision: 1, incarnationId: `retained-${i}`, retired: true as const }
      ])
    )
    useAppStore.setState({ ptyProcessMetadataById: retained, ptyProcessObservationRevision: 1 })
    let rowReads = 0
    let inventory = rows
    window.api.pty.listSessions = vi.fn(async () =>
      inventory.map((row): PtyListedSession => ({
        ...row,
        get id() {
          rowReads++
          return row.id
        },
        get incarnationId() {
          rowReads++
          return row.incarnationId
        },
        get shellPath() {
          rowReads++
          return row.shellPath
        },
        get wslDistro() {
          rowReads++
          return row.wslDistro
        },
        get exiting() {
          rowReads++
          return row.exiting
        }
      }))
    )
    const assign = Object.assign
    const maps = new WeakSet<object>([retained])
    let clones = 0
    let properties = 0
    const copying = vi.spyOn(Object, 'assign').mockImplementation((target, ...sources) => {
      const source = sources[0]
      const isMapClone = sources.length === 1 && maps.has(source)
      const result = assign(target, ...sources)
      if (isMapClone) {
        clones++
        properties += Object.keys(source).length
        maps.add(result)
      }
      return result
    })
    const notified = vi.fn()
    const unsubscribe = useAppStore.subscribe(notified)
    const changed = vi.fn()
    const consumer = createIpcPtyProcessDescription(true, () => 'live-0', changed, {})
    consumer.bind('inc-0')
    const list = () => listActivationPtySessions({ repos: [{ id: 'repo' }] }, 'repo::/src')
    try {
      // Calibrate against intermediate unpublished clones, not only the store's final map.
      let intermediate = retained
      for (let i = 0; i < 3; i++) {
        intermediate = Object.assign({}, intermediate)
      }
      expect([clones, properties]).toEqual([3, 3 * size])
      clones = properties = 0
      await list()
      expect([clones, properties, notified.mock.calls.length]).toEqual([1, size, 1])
      expect(rowReads).toBeLessThanOrEqual(10 * size)
      expect(useAppStore.getState().ptyProcessObservationRevision).toBe(size + 1)
      expect(changed).toHaveBeenCalledTimes(2)
      const before = useAppStore.getState()
      const map = before.ptyProcessMetadataById
      const entry = map['local\0live-0']
      rows.forEach((row, i) =>
        expect(map[`local\0${row.id}`]).toEqual({
          incarnationId: row.incarnationId,
          shellPath: row.shellPath,
          wslDistro: null,
          observationRevision: i + 2
        })
      )
      clones = properties = rowReads = 0
      notified.mockClear()
      changed.mockClear()
      await list()
      captureLocalPtyProcessDescription(true)(rows[0])
      captureLocalPtyProcessDescription(true)({
        id: rows[0].id,
        incarnationId: rows[0].incarnationId,
        shellPath: ''
      })
      expect([clones, properties, notified.mock.calls.length]).toEqual([0, 0, 0])
      expect(rowReads).toBeLessThanOrEqual(10 * size)
      expect(useAppStore.getState()).toBe(before)
      expect(useAppStore.getState().ptyProcessMetadataById).toBe(map)
      expect(useAppStore.getState().ptyProcessMetadataById['local\0live-0']).toBe(entry)
      expect(changed).not.toHaveBeenCalled()

      inventory = rows.map((row) => ({ ...row, shellPath: 'wsl.exe', wslDistro: 'Debian' }))
      clones = properties = rowReads = 0
      await list()
      expect([clones, properties, notified.mock.calls.length]).toEqual([1, 2 * size, 1])
      expect(rowReads).toBeLessThanOrEqual(10 * size)
      expect(useAppStore.getState().ptyProcessObservationRevision).toBe(size + 1)
      expect(changed).toHaveBeenCalledOnce()
      expect(consumer.getContext()).toMatchObject({ shellOverride: 'wsl.exe', wslDistro: 'Debian' })
      const enriched = useAppStore.getState().ptyProcessMetadataById
      rows.forEach((row, i) =>
        expect(enriched[`local\0${row.id}`]).toEqual({
          incarnationId: row.incarnationId,
          shellPath: 'wsl.exe',
          wslDistro: 'Debian',
          observationRevision: i + 2
        })
      )
      for (const [key, value] of Object.entries(retained)) {
        expect(enriched[key]).toBe(value)
      }

      inventory = [{ ...rows[0], shellPath: 'cmd.exe' }, ...inventory.slice(1)]
      clones = properties = rowReads = 0
      notified.mockClear()
      await list()
      expect([clones, properties, notified.mock.calls.length]).toEqual([1, 2 * size, 1])
      expect(rowReads).toBeLessThanOrEqual(10 * size)
      expect(consumer.getContext()).toMatchObject({ shellOverride: 'cmd.exe', wslDistro: null })
      expect(changed).toHaveBeenCalledTimes(2)
      const after = useAppStore.getState().ptyProcessMetadataById
      for (const [key, value] of Object.entries(enriched)) {
        if (key !== 'local\0live-0') {
          expect(after[key]).toBe(value)
        }
      }
    } finally {
      consumer.detach()
      unsubscribe()
      copying.mockRestore()
    }
  })

  it('preserves ordered lifetime fences, partial enrichment and inventory failure containment', async () => {
    const { listActivationPtySessions } = await import('@/lib/worktree-activation-pty-inventory')
    const { captureLocalPtyProcessDescription, createIpcPtyProcessDescription } =
      await import('./ipc-pty-process-description')
    const { useAppStore } = await import('@/store')
    const row = {
      id: 'ordered',
      incarnationId: 'A',
      shellPath: 'wsl.exe',
      wslDistro: 'Debian',
      cwd: '',
      title: '',
      agentOwnership: 'unknown' as const
    }
    const inventory = [
      row,
      { ...row, incarnationId: 'B', shellPath: 'cmd.exe' },
      { ...row, shellPath: '', wslDistro: null }
    ]
    window.api.pty.listSessions = vi.fn(async () => inventory)
    const list = () => listActivationPtySessions({ repos: [{ id: 'repo' }] }, 'repo::/src')
    expect(await list()).toBe(inventory)
    expect(useAppStore.getState().ptyProcessMetadataById['local\0ordered']).toEqual({
      incarnationId: 'A',
      shellPath: 'wsl.exe',
      wslDistro: null,
      observationRevision: 1
    })
    const consumer = createIpcPtyProcessDescription(true, () => row.id, vi.fn(), {})
    consumer.bind('A')
    const retire = consumer.captureRetirement()
    captureLocalPtyProcessDescription(true)({ id: row.id, incarnationId: 'A', wslDistro: 'Ubuntu' })
    expect(consumer.getContext()).toMatchObject({ shellPath: 'wsl.exe', wslDistro: 'Ubuntu' })
    retire()
    const retired = useAppStore.getState()
    const retiredRows = [row, { ...row, incarnationId: undefined }]
    vi.mocked(window.api.pty.listSessions).mockResolvedValueOnce(retiredRows)
    expect(await list()).toBe(retiredRows)
    expect(useAppStore.getState()).toBe(retired)
    consumer.detach()

    const legacy = { id: 'legacy-clock', shellPath: 'cmd.exe' }
    captureLocalPtyProcessDescription(true)(legacy)
    const older = captureLocalPtyProcessDescription(true)
    const revision = useAppStore.getState().ptyProcessObservationRevision
    captureLocalPtyProcessDescription(true)(legacy)
    expect(useAppStore.getState().ptyProcessObservationRevision).toBe(revision + 1)
    const fresh = useAppStore.getState()
    older({ ...legacy, shellPath: 'wsl.exe' })
    expect(useAppStore.getState()).toBe(fresh)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unsubscribe = useAppStore.subscribe(() => {
      throw new Error('description failed')
    })
    vi.mocked(window.api.pty.listSessions).mockResolvedValueOnce([{ ...row, id: 'new-row' }])
    try {
      expect(await list()).toEqual([{ ...row, id: 'new-row' }])
      expect(warn).toHaveBeenCalledWith(
        '[pty] could not update process description',
        expect.any(Error)
      )
      vi.mocked(window.api.pty.listSessions).mockRejectedValueOnce(new Error('inventory failed'))
      await expect(list()).rejects.toThrow('inventory failed')
    } finally {
      unsubscribe()
      warn.mockRestore()
    }
  })

  it('retains a pending spawn across view disposal and adopts it before direct-attach replay/input', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof window.api.pty.spawn>>>()
    vi.mocked(window.api.pty.spawn).mockReturnValueOnce(pending.promise)
    const first = createIpcPtyTransport({ retainDisposedSpawn: () => true })
    const starting = first.connect({ url: '', callbacks: {} })
    first.detach?.()
    first.destroy?.()
    pending.resolve({
      id: 'survivor',
      incarnationId: 'old',
      shellPath: 'C:\\Windows\\System32\\wsl.exe',
      wslDistro: 'Debian'
    })
    await starting
    data?.({ id: 'survivor', data: 'initial replay' })
    const next = createIpcPtyTransport({ cwd: 'C:\\src', shellOverride: 'cmd.exe' })
    const metadata = vi.fn(() => next.getLocalSessionMetadata?.())
    const replayMetadata = vi.fn(() => next.getLocalSessionMetadata?.())
    const sendInput = vi.fn(() => next.sendInput('typed', 'driving'))
    next.attach({
      existingPtyId: 'survivor',
      callbacks: {
        onSessionMetadataChanged: metadata,
        onData: replayMetadata,
        onConnect: sendInput
      }
    })
    expect(metadata.mock.results[0]?.value).toMatchObject({
      wslDistro: 'Debian',
      shellOverride: 'C:\\Windows\\System32\\wsl.exe'
    })
    expect(replayMetadata.mock.results[0]?.value?.wslDistro).toBe('Debian')
    expect(sendInput.mock.results[0]?.value).toBe(true)
    const { ptyShutdownLifecycleHandlers } = await import('./pty-dispatcher')
    const { captureLocalPtyProcessDescription } = await import('./ipc-pty-process-description')
    captureLocalPtyProcessDescription(true)({
      id: 'survivor',
      incarnationId: 'old',
      wslDistro: 'Debian'
    })
    ptyShutdownLifecycleHandlers.get('survivor')?.commit?.()
    const { readTerminalProcessMetadata } =
      await import('@/store/terminals/terminal-process-metadata')
    const { useAppStore } = await import('@/store')
    expect(readTerminalProcessMetadata(useAppStore.getState(), 'local', 'survivor')).toBeUndefined()
    next.disconnect()
  })

  it('hydrates without holding typing and rejects inventory/spawn answers from a replaced lifetime', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const inventory = Promise.withResolvers<PtyListedSession[]>()
    window.api.pty.listSessions = vi.fn(() => inventory.promise)
    const oldSpawn = Promise.withResolvers<Awaited<ReturnType<typeof window.api.pty.spawn>>>()
    vi.mocked(window.api.pty.spawn).mockReturnValueOnce(oldSpawn.promise)
    const pending = createIpcPtyTransport({ retainDisposedSpawn: () => true })
    const starting = pending.connect({ url: '', callbacks: {} })
    pending.detach?.()
    const unknown = createIpcPtyTransport({ shellOverride: 'wsl.exe' })
    unknown.attach({ existingPtyId: 'reused', callbacks: {} })
    expect(unknown.sendInput('before inventory', 'driving')).toBe(true)
    expect(window.api.pty.listSessions).toHaveBeenCalledWith({ connectionId: null })
    vi.mocked(window.api.pty.spawn).mockResolvedValueOnce({
      id: 'reused',
      incarnationId: 'new',
      shellPath: 'cmd.exe',
      wslDistro: 'Ubuntu'
    })
    const replacement = createIpcPtyTransport({
      cwd: '\\\\wsl$\\Ubuntu\\src',
      shellOverride: 'wsl.exe'
    })
    await replacement.connect({ url: '', callbacks: {} })
    inventory.resolve([
      {
        id: 'reused',
        cwd: '',
        title: '',
        agentOwnership: 'unknown',
        incarnationId: 'old',
        shellPath: 'wsl.exe',
        wslDistro: 'Ubuntu'
      }
    ])
    oldSpawn.resolve({
      id: 'reused',
      incarnationId: 'old',
      shellPath: 'wsl.exe',
      wslDistro: 'Ubuntu'
    })
    await starting
    expect(replacement.getLocalSessionMetadata?.()).toMatchObject({
      shellOverride: 'cmd.exe',
      wslDistro: null,
      cwd: '\\\\wsl$\\Ubuntu\\src'
    })
    const { readTerminalProcessMetadata } =
      await import('@/store/terminals/terminal-process-metadata')
    const { useAppStore } = await import('@/store')
    expect(
      readTerminalProcessMetadata(useAppStore.getState(), 'local', 'reused')?.incarnationId
    ).toBe('new')
    exit?.({ id: 'reused', code: 0, incarnationId: 'new' })
    expect(readTerminalProcessMetadata(useAppStore.getState(), 'local', 'reused')).toBeUndefined()
    unknown.detach?.()
    pending.destroy?.()
    replacement.disconnect()
  })

  it('completes the start when descriptive subscribers or pane refresh fail', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { useAppStore } = await import('@/store')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unsubscribe = useAppStore.subscribe(() => {
      throw new Error('description subscriber failed')
    })
    vi.mocked(window.api.pty.spawn).mockResolvedValueOnce({
      id: 'usable',
      shellPath: 'cmd.exe',
      wslDistro: null
    })
    const transport = createIpcPtyTransport()
    try {
      expect(
        await transport.connect({
          url: '',
          callbacks: {
            onSessionMetadataChanged: () => {
              throw new Error('pane refresh failed')
            }
          }
        })
      ).toMatchObject({ id: 'usable' })
      expect(transport.sendInput('still usable', 'driving')).toBe(true)
      expect(warn).toHaveBeenCalled()
    } finally {
      unsubscribe()
      transport.disconnect()
      warn.mockRestore()
    }
  })

  it('keeps a successor through stale stop/exit callbacks and retains facts when kill fails', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { ptyExitHandlers, unregisterPtyDataHandlers } = await import('./pty-dispatcher')
    const { readTerminalProcessMetadata } =
      await import('@/store/terminals/terminal-process-metadata')
    const { useAppStore } = await import('@/store')
    const read = () => readTerminalProcessMetadata(useAppStore.getState(), 'local', 'rebound')
    const transport = createIpcPtyTransport()
    vi.mocked(window.api.pty.spawn).mockResolvedValueOnce({
      id: 'rebound',
      incarnationId: 'old',
      shellPath: 'wsl.exe',
      wslDistro: 'Debian'
    })
    await transport.connect({ url: '', callbacks: {} })
    const lateExit = ptyExitHandlers.get('rebound')
    const [stop] = unregisterPtyDataHandlers(['rebound'])
    transport.detach?.()
    vi.mocked(window.api.pty.spawn).mockResolvedValueOnce({
      id: 'rebound',
      incarnationId: 'new',
      shellPath: 'cmd.exe',
      wslDistro: null
    })
    await transport.connect({ url: '', callbacks: {} })
    stop.commit()
    lateExit?.(0)
    expect(read()?.incarnationId).toBe('new')
    expect(transport.sendInput('successor remains usable', 'driving')).toBe(true)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(window.api.pty.kill).mockRejectedValueOnce(new Error('kill failed'))
    transport.disconnect()
    await flushPtySideEffects()
    expect(read()?.shellPath).toBe('cmd.exe')
    const restored = createIpcPtyTransport({ shellOverride: 'wsl.exe' })
    restored.attach({ existingPtyId: 'rebound', callbacks: {} })
    expect(restored.getLocalSessionMetadata?.()?.wslDistro).toBeNull()
    restored.detach?.()
    expect(read()?.incarnationId).toBe('new')
    restored.attach({ existingPtyId: 'rebound', callbacks: {} })
    vi.mocked(window.api.pty.kill).mockResolvedValueOnce(undefined)
    restored.disconnect()
    await flushPtySideEffects()
    expect(read()).toBeUndefined()
    warn.mockRestore()
  })

  it.each([true, false])(
    'keeps captured attach identity after retirement, fences unpublished exits and delivers every sidecar (initial facts: %s)',
    async (hasInitialFacts) => {
      const { captureLocalPtyProcessDescription } = await import('./ipc-pty-process-description')
      const { createIpcPtyTransport } = await import('./pty-transport')
      const { subscribeToPtyExit, ptyShutdownLifecycleHandlers, unregisterPtyDataHandlers } =
        await import('./pty-dispatcher')
      const { useAppStore } = await import('@/store')
      const { readTerminalProcessMetadata } =
        await import('@/store/terminals/terminal-process-metadata')
      const read = () => readTerminalProcessMetadata(useAppStore.getState(), 'local', 'lifetime')
      const first = createIpcPtyTransport()
      first.attach({ existingPtyId: 'lifetime', callbacks: {} })
      if (hasInitialFacts) {
        captureLocalPtyProcessDescription(true)({
          id: 'lifetime',
          incarnationId: 'A',
          shellPath: 'wsl.exe'
        })
      }
      const stopA = ptyShutdownLifecycleHandlers.get('lifetime')!
      const pendingB = captureLocalPtyProcessDescription(true)
      const lateA = captureLocalPtyProcessDescription(true)
      unregisterPtyDataHandlers(['lifetime'])
      exit?.({ id: 'lifetime', code: 0, incarnationId: 'A' })
      expect(read()).toBeUndefined()
      ;(hasInitialFacts ? pendingB : captureLocalPtyProcessDescription(true))({
        id: 'lifetime',
        incarnationId: 'B',
        shellPath: 'cmd.exe'
      })
      expect(first.getLocalSessionMetadata?.()?.shellPath).toBeUndefined()
      stopA.commit()
      first.detach?.({ preserveExitObserver: false })
      expect(read()?.incarnationId).toBe('B')
      const stale = captureLocalPtyProcessDescription(true)
      const delivered = vi.fn()
      subscribeToPtyExit('lifetime', delivered)
      exit?.({ id: 'lifetime', code: 0, incarnationId: 'foreign' })
      expect(read()?.incarnationId).toBe('B')
      stale({ id: 'lifetime', incarnationId: 'older', shellPath: 'wsl.exe' })
      expect(read()?.incarnationId).toBe('B')
      exit?.({ id: 'lifetime', code: 0, incarnationId: 'B', ptySourceDisowned: true })
      expect(read()?.incarnationId).toBe('B')
      expect(delivered).toHaveBeenCalledOnce()
      exit?.({ id: 'lifetime', code: 0, incarnationId: 'B' })
      lateA({ id: 'lifetime', incarnationId: 'A', shellPath: 'wsl.exe' })
      expect(read()).toBeUndefined()
      const beforeUnseen = captureLocalPtyProcessDescription(true)
      exit?.({ id: 'unseen', code: 0, incarnationId: 'X' })
      const betweenExits = captureLocalPtyProcessDescription(true)
      exit?.({ id: 'unseen', code: 0, incarnationId: 'Y' })
      beforeUnseen({ id: 'unseen', incarnationId: 'X', shellPath: 'cmd.exe' })
      betweenExits({ id: 'unseen', incarnationId: 'Y', shellPath: 'cmd.exe' })
      expect(readTerminalProcessMetadata(useAppStore.getState(), 'local', 'unseen')).toBeUndefined()
      const sidecar = vi.fn(),
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { installPtyProcessExitObserver } = await import('./pty-process-observation')
      installPtyProcessExitObserver(() => {
        throw new Error('description failed')
      })
      const faulty = createIpcPtyTransport({
        onPtyExit: () => {
          throw new Error('primary failed')
        }
      })
      faulty.attach({ existingPtyId: 'throwing', callbacks: {} })
      subscribeToPtyExit('throwing', () => {
        throw new Error('first sidecar failed')
      })
      subscribeToPtyExit('throwing', sidecar)
      try {
        exit?.({ id: 'throwing', code: 0 })
      } catch {
        /* Delivery aggregates subscriber failures. */
      }
      expect(sidecar).toHaveBeenCalledOnce()
      warn.mockRestore()
    }
  )

  it('publishes scoped inventory to an inactive card before any pane mounts', async () => {
    const { listActivationPtySessions } = await import('@/lib/worktree-activation-pty-inventory')
    const { readTerminalTabShell, readTerminalProcessMetadata } =
      await import('@/store/terminals/terminal-process-metadata')
    const { useAppStore } = await import('@/store')
    const row = {
      id: 'cold',
      cwd: 'C:/src',
      title: '',
      agentOwnership: 'unknown' as const,
      incarnationId: 'live',
      shellPath: 'cmd.exe',
      wslDistro: null
    }
    window.api.pty.listSessions = vi.fn(async () => {
      expect(exit).toBeTypeOf('function')
      return [row]
    })
    useAppStore.setState({ ptyIdsByTabId: { inactive: ['cold'] }, activeWorktreeId: 'other' })
    await listActivationPtySessions({ repos: [{ id: 'repo' }] }, 'repo::/src')
    expect(
      readTerminalTabShell(useAppStore.getState(), { id: 'inactive', shellOverride: 'wsl.exe' })
    ).toBe('cmd.exe')
    expect(window.api.pty.listSessions).toHaveBeenCalledExactlyOnceWith({ connectionId: null })
    vi.mocked(window.api.pty.listSessions).mockResolvedValueOnce([{ ...row, id: 'foreign' }])
    await listActivationPtySessions({ repos: [{ id: 'repo', connectionId: 'box' }] }, 'repo::/src')
    vi.mocked(window.api.pty.listSessions).mockResolvedValueOnce([
      { ...row, id: 'exiting', exiting: true }
    ])
    await listActivationPtySessions({ repos: [{ id: 'repo' }] }, 'repo::/src')
    expect(readTerminalProcessMetadata(useAppStore.getState(), 'local', 'foreign')).toBeUndefined()
    expect(readTerminalProcessMetadata(useAppStore.getState(), 'local', 'exiting')).toBeUndefined()
    exit?.({ id: 'cold', code: 0, incarnationId: 'live' })
    expect(readTerminalProcessMetadata(useAppStore.getState(), 'local', 'cold')).toBeUndefined()
    const pending = Promise.withResolvers<PtyListedSession[]>()
    vi.mocked(window.api.pty.listSessions).mockImplementationOnce(() => {
      expect(exit).toBeTypeOf('function')
      return pending.promise
    })
    const listing = listActivationPtySessions({ repos: [{ id: 'repo' }] }, 'repo::/src')
    exit?.({ id: 'during-list', code: 0, incarnationId: 'ended' })
    pending.resolve([{ ...row, id: 'during-list', incarnationId: 'ended' }])
    await listing
    expect(
      readTerminalProcessMetadata(useAppStore.getState(), 'local', 'during-list')
    ).toBeUndefined()
  })

  it('leaves a restored terminal usable when descriptive inventory fails', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    window.api.pty.listSessions = vi.fn().mockRejectedValue(new Error('owner unavailable'))
    const transport = createIpcPtyTransport({ shellOverride: 'wsl.exe' })
    transport.attach({ existingPtyId: 'legacy', callbacks: {} })
    await flushPtySideEffects()
    expect(transport.sendInput('still usable', 'driving')).toBe(true)
    expect(transport.getLocalSessionMetadata?.()).toEqual({
      cwd: undefined,
      shellOverride: 'wsl.exe'
    })
    transport.disconnect()
  })

  it.each([
    {
      facts: { wslDistro: null },
      runtimeKey: 'local:win32',
      expected: { shellOverride: 'wsl.exe', wslDistro: null, cwd: '\\\\wsl$\\Stale\\src' }
    },
    {
      facts: { shellPath: 'wsl.exe', wslDistro: null },
      runtimeKey: 'wsl:default',
      expected: { shellOverride: 'wsl.exe', wslDistro: undefined, cwd: '\\\\wsl$\\Stale\\src' }
    },
    {
      facts: {},
      runtimeKey: 'wsl:Stale',
      expected: { shellOverride: 'wsl.exe', cwd: '\\\\wsl$\\Stale\\src' }
    }
  ])(
    'keeps native, unknown-distro WSL and legacy omission distinct: $facts',
    async ({ facts, expected, runtimeKey }) => {
      const { createIpcPtyTransport } = await import('./pty-transport')
      window.api.pty.listSessions = vi.fn(async () => [
        { id: 'contract', cwd: '', title: '', agentOwnership: 'unknown' as const, ...facts }
      ])
      const transport = createIpcPtyTransport({
        cwd: '\\\\wsl$\\Stale\\src',
        shellOverride: 'wsl.exe'
      })
      transport.attach({ existingPtyId: 'contract', callbacks: {} })
      expect(transport.sendInput('while hydrating', 'driving')).toBe(true)
      await flushPtySideEffects()
      expect(transport.getLocalSessionMetadata?.()).toMatchObject(expected)
      const { resolveTerminalPasteRuntime } = await import('./terminal-paste-runtime')
      const { isTerminalPaneLocalWindowsConpty } =
        await import('./terminal-pane-local-windows-conpty')
      const { useAppStore } = await import('@/store')
      expect(
        resolveTerminalPasteRuntime({ platform: 'win32', ptyId: 'contract', transport }).runtimeKey
      ).toBe(runtimeKey)
      expect(
        isTerminalPaneLocalWindowsConpty({
          isWindows: true,
          userAgent: 'Windows',
          state: useAppStore.getState(),
          worktreeId: 'repo::/src',
          tabId: 't',
          paneId: 1,
          paneCwd: new Map(),
          fallbackCwd: '\\\\wsl$\\Stale\\src',
          transport
        })
      ).toBe(runtimeKey === 'local:win32')
      exit?.({ id: 'contract', code: 0 })
      const { readTerminalProcessMetadata } =
        await import('@/store/terminals/terminal-process-metadata')
      expect(
        readTerminalProcessMetadata(useAppStore.getState(), 'local', 'contract')
      ).toBeUndefined()
      transport.disconnect()
    }
  )
})
