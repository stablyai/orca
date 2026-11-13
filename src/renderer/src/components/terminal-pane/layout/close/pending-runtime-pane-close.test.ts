import { expect, it } from 'vitest'
import { preparePendingRuntimeClose } from './pending-runtime-pane-close-test-fixture'
import { makeCloseTestTab } from './pending-split-close-test-fixture'

it.each(['same-leaf', 'other-tab', 'bound-transport', 'worktree-owner', 'pairing'] as const)(
  'rechecks %s ownership after compatibility settles',
  async (owner) => {
    const p = await preparePendingRuntimeClose()
    p.actions.executeClosePane(1, 'user')
    expect(p.runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'status.get' }))
    const id = 'remote:env-1@@term_original'
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
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

it('never turns a late different resolved handle into close authority', async () => {
  const p = await preparePendingRuntimeClose()
  p.actions.executeClosePane(1, 'user')
  p.acceptCompatibility()
  await p.settle('term_replacement')
  expect(
    p.runtimeCall.mock.calls.filter(([request]) => request.method === 'terminal.close')
  ).toEqual([[expect.objectContaining({ params: { terminal: 'term_original' } })]])
})
