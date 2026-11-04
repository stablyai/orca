// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { setupMountedReuseClose } from './terminal-mounted-reuse-close.test-fixture'
import { mountReservedTerminal } from './terminal-mounted-reuse-close-renderer.test-fixture'

// Pane identity and connection remain real; happy-dom has no terminal painting surface.
vi.mock('../../src/renderer/src/lib/pane-manager/pane-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openTerminal: () => {}
}))

it('closes the original mounted launch once while its real preload reply is pending', async () => {
  const fixture = await setupMountedReuseClose()
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame'
    ]
  })
  let mounted: Awaited<ReturnType<typeof mountReservedTerminal>> | undefined
  try {
    mounted = await mountReservedTerminal(fixture)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(fixture.spawn).toHaveBeenCalledTimes(1)
    expect(fixture.completedReply()).toBe(true)
    const { runtime, handle, seed, pane } = fixture
    const workspaceId = seed.workspaceId!
    const original = runtime['getLivePtyForHandle'](handle)!
    const process = fixture.processes.get(seed.terminalPtyId!)!
    const authority = runtime['resolvePtyTabCloseSurfaceAuthority']({
      handle,
      ptyId: original.pty.ptyId,
      incarnationId: original.pty.incarnationId!,
      worktreeId: workspaceId
    })
    const raw = runtime['mobileSessionTabsByWorktree']
      .get(workspaceId)
      ?.tabs.find((row) => row.type === 'terminal' && row.parentTabId === pane.tabId)
    expect({
      mounted: runtime['tabs'].has(pane.tabId),
      accepted: Boolean(runtime['acceptedRendererMobileSnapshotByWorktree'].get(workspaceId)),
      authority: authority !== null,
      rawPty: raw && raw.type === 'terminal' ? (raw.ptyId ?? null) : 'missing',
      membership: fixture.membership(),
      live: fixture.processes.has(seed.terminalPtyId!)
    }).toEqual({
      mounted: true,
      accepted: true,
      authority: false,
      rawPty: null,
      membership: { saved: true, layout: true, raw: true, renderer: true },
      live: true
    })
    let result: Awaited<ReturnType<typeof runtime.closeTerminal>> | undefined
    await act(async () => {
      result = await runtime.closeTerminal(handle)
    })
    expect(result).toEqual({ handle, tabId: pane.tabId, ptyKilled: true })
    expect(fixture.order).toEqual([
      'main-spawn-result',
      'ack',
      'runtime-owner-completed',
      'captured-stop'
    ])
    expect(fixture.ownerResults).toEqual([
      {
        ptyIds: [],
        membership: { saved: false, layout: false, raw: true, renderer: false }
      }
    ])
    expect(fixture.membership()).toEqual({
      saved: false,
      layout: false,
      raw: false,
      renderer: false
    })
    expect(fixture.stops).toEqual([
      {
        id: seed.terminalPtyId,
        incarnationId: process.incarnationId,
        membership: { saved: false, layout: false, raw: false, renderer: false }
      }
    ])
    expect(fixture.stopAndWait).toHaveBeenCalledExactlyOnceWith(seed.terminalPtyId, {
      deadlineMs: expect.any(Number)
    })
    expect(fixture.kill).not.toHaveBeenCalled()
    expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(
      seed.terminalPtyId,
      0,
      process.incarnationId
    )
    expect(fixture.processes.size).toBe(0)
    fixture.release()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(fixture.order.at(-1)).toBe('delivered-spawn-result')
    expect(fixture.membership()).toEqual({
      saved: false,
      layout: false,
      raw: false,
      renderer: false
    })
    expect(fixture.processes.size).toBe(0)
    expect(fixture.spawn).toHaveBeenCalledTimes(1)
    expect(fixture.stopAndWait).toHaveBeenCalledTimes(1)
    expect(fixture.exit).toHaveBeenCalledTimes(1)
  } finally {
    fixture.release()
    await mounted?.dispose()
    vi.useRealTimers()
    await fixture.dispose()
  }
})
