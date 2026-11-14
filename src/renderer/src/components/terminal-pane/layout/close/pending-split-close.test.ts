import { expect, it, vi } from 'vitest'
import { makeCloseTestTab, preparePendingSplitClose } from './pending-split-close-test-fixture'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'

const replyFor = (kind: 'reattach' | 'cold-restore-new' | 'ordinary-fresh') => ({
  id: 'pty-restored',
  ...(kind === 'reattach' ? { isReattach: true } : {}),
  ...(kind === 'cold-restore-new' ? { coldRestore: { scrollback: 'saved', cwd: '/tmp' } } : {})
})

it.each(['same-leaf', 'different-tab', 'new-transport-map'] as const)(
  'protects a %s replacement that adopts after explicit close',
  async (owner) => {
    const p = await preparePendingSplitClose()
    p.actions.executeClosePane(1, 'user')
    await p.mainAnswered()
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
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

it('commits the explicit split close in main by its leaf without waiting for its write', async () => {
  const p = await preparePendingSplitClose()
  // Main's durable write never settles here: the pane must still leave and be killed at once.
  const closeTerminalSurface = vi.fn(() => new Promise<void>(() => {}))
  Object.assign(window.api, { session: { ...window.api.session, closeTerminalSurface } })
  p.actions.executeClosePane(1, 'user')
  await p.mainAnswered()
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    expect(p.sentPaneCloses()).toEqual([
      { type: 'closePane', workspace: 'workspace', tabId: p.tabId, leafId: p.leafId }
    ])
  } else {
    expect(closeTerminalSurface).toHaveBeenCalledExactlyOnceWith({
      worktreeId: 'workspace',
      target: { kind: 'pane', tabId: p.tabId, leafId: p.leafId }
    })
  }
  expect(p.transports.has(1)).toBe(false)
  expect(p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId?.[p.leafId]).toBeUndefined()
  expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith('pty-restored')
})
