import { expect, it, vi } from 'vitest'
import { preparePendingRuntimeClose } from './pending-runtime-pane-close-test-fixture'
import { makeCloseTestTab } from './pending-split-close-test-fixture'

it('closes the captured scoped handle while actual remote attach is still unbound', async () => {
  const p = await preparePendingRuntimeClose()
  expect(p.runtimeCall).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'terminal.resolvePane' })
  )
  expect(p.remote.getPtyId()).toBeNull()
  p.actions.executeClosePane(1)
  expect(p.runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'status.get' }))
  p.acceptCompatibility()
  await p.settle()
  expect(p.runtimeCall).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'terminal.close',
      params: { terminal: 'term_original' },
      expectedEnvironmentPairingRevision: 1
    })
  )
  expect(window.api.pty.kill).not.toHaveBeenCalled()
})

it('normal remount keeps the captured remote handle', async () => {
  const p = await preparePendingRuntimeClose()
  p.remote.detach?.()
  p.acceptCompatibility()
  await p.settle()
  expect(p.runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
    'terminal.close'
  )
  expect(p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId?.[p.leafId]).toBe(
    'remote:env-1@@term_original'
  )
})

it.each(['same-leaf', 'other-tab', 'bound-transport', 'worktree-owner', 'pairing'] as const)(
  'rechecks %s ownership after compatibility settles',
  async (owner) => {
    const p = await preparePendingRuntimeClose()
    p.actions.executeClosePane(1)
    expect(p.runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'status.get' }))
    const id = 'remote:env-1@@term_original'
    const { createIpcPtyTransport } = await import('./pty-transport')
    const survivor = createIpcPtyTransport({})
    if (owner === 'same-leaf') {
      p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId = { [p.leafId]: id }
    } else if (owner === 'other-tab') {
      p.state.tabsByWorktree.workspace.push(makeCloseTestTab('replacement', 'remote:term_original'))
    } else if (owner === 'bound-transport') {
      survivor.attach({ existingPtyId: id, callbacks: {} })
      p.controller.paneTransportsRef.current = new Map([[1, survivor]])
    } else if (owner === 'worktree-owner') {
      p.state.worktreesByRepo = {
        repo: [{ id: 'workspace', repoId: 'repo', runtimeOwnerEnvironmentId: 'env-2' }]
      }
    } else {
      p.replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 2, pairingRevision: 2 }])
    }
    p.acceptCompatibility()
    await p.settle()
    expect(p.runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'terminal.close'
    )
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    survivor.detach?.({ preserveExitObserver: false })
  }
)

it('protects a sibling legacy alias before issuing a compatibility request', async () => {
  const p = await preparePendingRuntimeClose()
  p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId = {
    [p.leafId]: 'remote:env-1@@term_original',
    [p.siblingLeafId]: 'remote:term_original'
  }
  p.actions.executeClosePane(1)
  p.acceptCompatibility()
  await p.settle()
  expect(p.runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
    'terminal.resolvePane'
  ])
})

it.each(['ssh:host@@native-hint', 'remote:term_original', 'remote:env-2@@term_original'])(
  'refuses to infer close authority from %s',
  async (id) => {
    const p = await preparePendingRuntimeClose(id)
    p.actions.executeClosePane(1)
    p.acceptCompatibility()
    await p.settle()
    expect(p.runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'terminal.close'
    )
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  }
)

it('does not bypass a failed compatibility check', async () => {
  const p = await preparePendingRuntimeClose()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  p.actions.executeClosePane(1)
  p.compatibility.reject(new Error('incompatible runtime'))
  await p.settle()
  expect(p.runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
    'terminal.close'
  )
  expect(warn).toHaveBeenCalledWith(
    '[terminal-retirement] provider teardown failed',
    expect.objectContaining({ runtimeFailures: 1 })
  )
})

it('never turns a late different resolved handle into close authority', async () => {
  const p = await preparePendingRuntimeClose()
  p.actions.executeClosePane(1)
  p.acceptCompatibility()
  await p.settle('term_replacement')
  expect(
    p.runtimeCall.mock.calls.filter(([request]) => request.method === 'terminal.close')
  ).toEqual([[expect.objectContaining({ params: { terminal: 'term_original' } })]])
})
