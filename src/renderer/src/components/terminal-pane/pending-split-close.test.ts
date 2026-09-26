import { expect, it, vi } from 'vitest'
import { makeCloseTestTab, preparePendingSplitClose } from './pending-split-close-test-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { flushPtySideEffects } from './pty-transport-test-harness'

const replyFor = (kind: 'reattach' | 'cold-restore-new' | 'ordinary-fresh') => ({
  id: 'pty-restored',
  ...(kind === 'reattach' ? { isReattach: true } : {}),
  ...(kind === 'cold-restore-new' ? { coldRestore: { scrollback: 'saved', cwd: '/tmp' } } : {})
})

it.each(['reattach', 'cold-restore-new', 'ordinary-fresh'] as const)(
  'explicit split close retires a pending %s before and after its reply',
  async (kind) => {
    const p = await preparePendingSplitClose()
    expect(p.transport.getPtyId()).toBeNull()
    p.actions.executeClosePane(1)
    expect(p.transports.has(1)).toBe(false)
    expect(p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId?.[p.leafId]).toBeUndefined()
    expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith('pty-restored')
    p.spawn.resolve(replyFor(kind))
    await p.connecting
    expect(window.api.pty.kill).toHaveBeenCalledTimes(2)
    expect(p.transport.getPtyId()).toBeNull()
  }
)

it.each(['reattach', 'cold-restore-new'] as const)(
  'ordinary remount preserves pending %s for adoption',
  async (kind) => {
    const p = await preparePendingSplitClose()
    p.transport.detach?.({ preserveExitObserver: false })
    p.spawn.resolve(replyFor(kind))
    await p.connecting
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    expect(p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId?.[p.leafId]).toBe('pty-restored')
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockResolvedValueOnce({ id: 'pty-restored', isReattach: true })
    const replacement = createIpcPtyTransport({})
    await replacement.connect({ url: '', sessionId: 'pty-restored', callbacks: {} })
    expect(replacement.getPtyId()).toBe('pty-restored')
    replacement.detach?.({ preserveExitObserver: false })
  }
)

it.each(['layout', 'transport'] as const)(
  'protects a sibling owner recorded only in %s',
  async (owner) => {
    const p = await preparePendingSplitClose()
    const { createIpcPtyTransport } = await import('./pty-transport')
    const survivor = createIpcPtyTransport({})
    if (owner === 'transport') {
      survivor.attach({ existingPtyId: 'pty-restored', callbacks: {} })
      p.transports.set(2, survivor)
    } else {
      p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId = {
        [p.leafId]: 'pty-restored',
        [p.siblingLeafId]: 'pty-restored'
      }
    }
    p.actions.executeClosePane(1)
    p.spawn.resolve(replyFor('reattach'))
    await p.connecting
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    survivor.detach?.({ preserveExitObserver: false })
  }
)

it('protects a different tab owner present before explicit close', async () => {
  const p = await preparePendingSplitClose()
  p.state.tabsByWorktree.workspace.push(makeCloseTestTab('survivor', 'pty-restored'))
  p.actions.executeClosePane(1)
  p.spawn.resolve(replyFor('cold-restore-new'))
  await p.connecting
  expect(window.api.pty.kill).not.toHaveBeenCalled()
})

it.each(['same-leaf', 'different-tab', 'new-transport-map'] as const)(
  'protects a %s replacement that adopts after explicit close',
  async (owner) => {
    const p = await preparePendingSplitClose()
    p.actions.executeClosePane(1)
    const { createIpcPtyTransport } = await import('./pty-transport')
    const replacement = createIpcPtyTransport({})
    if (owner === 'same-leaf') {
      p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId = { [p.leafId]: 'pty-restored' }
    } else if (owner === 'different-tab') {
      p.state.tabsByWorktree.workspace.push(makeCloseTestTab('new-owner', 'pty-restored'))
    } else {
      replacement.attach({ existingPtyId: 'pty-restored', callbacks: {} })
      p.controller.paneTransportsRef.current = new Map([[1, replacement]])
    }
    p.spawn.resolve(replyFor('reattach'))
    await p.connecting
    expect(window.api.pty.kill).toHaveBeenCalledTimes(1)
    replacement.detach?.({ preserveExitObserver: false })
  }
)

it('retains explicit close intent across repeated generic destroy calls', async () => {
  const p = await preparePendingSplitClose()
  p.actions.executeClosePane(1)
  p.transport.destroy?.()
  p.transport.destroy?.()
  p.spawn.resolve(replyFor('cold-restore-new'))
  await p.connecting
  expect(window.api.pty.kill).toHaveBeenCalledTimes(2)
})

it('preserves a different returned reattach identity', async () => {
  const p = await preparePendingSplitClose()
  p.actions.executeClosePane(1)
  p.spawn.resolve({ id: 'different-existing-session', isReattach: true })
  await p.connecting
  expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith('pty-restored')
})

it('retries an eager provider failure when the same-ID reply arrives', async () => {
  const p = await preparePendingSplitClose()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(window.api.pty.kill).mockRejectedValueOnce(
    new Error('provider temporarily unavailable')
  )
  p.actions.executeClosePane(1)
  await flushPtySideEffects()
  expect(warn).toHaveBeenCalledWith(
    '[terminal-retirement] provider teardown failed',
    expect.any(Object)
  )
  p.spawn.resolve(replyFor('reattach'))
  await p.connecting
  expect(window.api.pty.kill).toHaveBeenCalledTimes(2)
})

it('does not invent a late session after a rejected spawn', async () => {
  const p = await preparePendingSplitClose()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  p.actions.executeClosePane(1)
  p.spawn.reject(new Error('spawn rejected'))
  await p.connecting
  expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith('pty-restored')
})

it('routes direct SSH retirement through the existing IPC identity', async () => {
  const id = 'ssh:ssh-1@@pty-restored'
  const p = await preparePendingSplitClose(id)
  p.state.worktreesByRepo = { repo: [{ id: 'workspace', repoId: 'repo', hostId: 'ssh:ssh-1' }] }
  p.actions.executeClosePane(1)
  p.spawn.resolve({ id, isReattach: true })
  await p.connecting
  expect(window.api.pty.kill).toHaveBeenNthCalledWith(1, id)
  expect(window.api.pty.kill).toHaveBeenNthCalledWith(2, id)
})

it.each(['runtime-handle', 'runtime-legacy', 'unresolved-owner', 'runtime-native-hint'] as const)(
  'never falls through to local kill for %s',
  async (kind) => {
    const id =
      kind === 'runtime-handle'
        ? 'remote:env-1@@pty-restored'
        : kind === 'runtime-legacy'
          ? 'remote:pty-restored'
          : 'pty-restored'
    const p = await preparePendingSplitClose(id)
    if (kind === 'unresolved-owner') {
      p.state.worktreesByRepo = {}
    } else if (kind === 'runtime-native-hint') {
      p.state.worktreesByRepo = {
        repo: [
          {
            id: 'workspace',
            repoId: 'repo',
            hostId: 'ssh:ssh-1',
            runtimeOwnerEnvironmentId: 'env-1'
          }
        ]
      }
    }
    p.actions.executeClosePane(1)
    p.spawn.resolve({ id, isReattach: true })
    await p.connecting
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  }
)

it('retires a local folder-workspace split without a git worktree row', async () => {
  const p = await preparePendingSplitClose('pty-restored', folderWorkspaceKey('folder-1'))
  p.state.worktreesByRepo = {}
  p.actions.executeClosePane(1)
  p.spawn.resolve(replyFor('reattach'))
  await p.connecting
  expect(window.api.pty.kill).toHaveBeenCalledTimes(2)
})

it('commits the explicit split close in main by its leaf without waiting for its write', async () => {
  const p = await preparePendingSplitClose()
  // Main's durable write never settles here: the pane must still leave and be killed at once.
  const closeTerminalSurface = vi.fn(() => new Promise<void>(() => {}))
  Object.assign(window.api, { session: { ...window.api.session, closeTerminalSurface } })
  p.actions.executeClosePane(1)
  expect(closeTerminalSurface).toHaveBeenCalledExactlyOnceWith({
    worktreeId: 'workspace',
    target: { kind: 'pane', tabId: p.tabId, leafId: p.leafId }
  })
  expect(p.transports.has(1)).toBe(false)
  expect(p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId?.[p.leafId]).toBeUndefined()
  expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith('pty-restored')
})
