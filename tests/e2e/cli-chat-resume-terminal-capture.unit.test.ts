// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { captureSourceTerminal } from '@/components/tab-bar/cli-chat-resume-terminal-capture'
import { toRemoteRuntimePtyId } from '../../src/shared/remote-runtime-pty-id'
import {
  createHarness,
  WORKTREE_ID,
  TAB_ID,
  LEAF_ID,
  PTY_ID,
  INCARNATION_ID
} from '../../src/main/runtime/__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  rpc.mockReset()
})
function source(ptyId: string | undefined, executionHostId: 'local' | 'runtime:paired' = 'local') {
  return {
    workspaceId: WORKTREE_ID,
    tabId: TAB_ID,
    paneKey: `${TAB_ID}:${LEAF_ID}`,
    agent: 'codex' as const,
    providerSessionId: 'conversation',
    executionHostId,
    ptyId
  }
}
function seed(harness: ReturnType<typeof createHarness>) {
  const session = harness.getSession()
  useAppStore.setState({
    tabsByWorktree: session.tabsByWorktree,
    terminalLayoutsByTabId: session.terminalLayoutsByTabId
  })
}

it('captures the authenticated original after earned shell exit and cleared renderer binding, then closes without another stop', async () => {
  const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
  const retained = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  const settle = harness.runtime.intentionalPtyStops.mark(PTY_ID, 'reversible', INCARNATION_ID)
  await harness.runtime.onPtyExit(PTY_ID, 0, INCARNATION_ID, { hostExitConfirmed: true })
  settle(true)
  harness.runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Ended',
        activeLeafId: LEAF_ID,
        layout: { type: 'leaf', leafId: LEAF_ID }
      }
    ],
    leaves: [
      { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 7, ptyId: null }
    ]
  })
  harness.editSession((state) => ({
    ...state,
    terminalLayoutsByTabId: {
      ...state.terminalLayoutsByTabId,
      [TAB_ID]: { ...state.terminalLayoutsByTabId[TAB_ID], ptyIdsByLeafId: {} }
    }
  }))
  harness.runtime.dropArchivedPtyRecord(PTY_ID)
  seed(harness)
  rpc.mockImplementation(async () => ({
    terminal: harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  }))
  const captured = await captureSourceTerminal(source(undefined))
  expect(captured?.handle).toBe(retained.handle)
  if (!captured?.presentation) {
    throw new Error('Expected authenticated original')
  }
  harness.setCloseTerminalTabAction(() => {})
  await expect(
    harness.runtime.closeTerminal(captured.handle, captured.incarnationId, captured.presentation)
  ).resolves.toMatchObject({ ptyKilled: true })
  expect(harness.stopAndWait).not.toHaveBeenCalled()
  expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
})

it.each(['row', 'incarnation', 'pty', 'workspace', 'leaf', 'host'] as const)(
  'refuses changed %s facts across resolve without recapturing',
  async (change) => {
    const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
    seed(harness)
    let resolvedTerminal: ReturnType<typeof harness.runtime.resolveTerminalPane> | undefined
    rpc.mockImplementation(async () => {
      if (change === 'row') {
        harness.editSession((state) => ({
          ...state,
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((row) => ({
              ...row,
              generation: (row.generation ?? 0) + 1
            }))
          }
        }))
      }
      if (change === 'incarnation') {
        harness.replacePersistedIncarnation('successor')
      }
      const terminal = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
      resolvedTerminal = terminal
      if (change === 'host') {
        terminal.executionHostId = 'ssh:successor'
      }
      if (change === 'pty') {
        terminal.ptyId = 'successor'
      }
      if (change === 'workspace' && terminal.presentation) {
        terminal.presentation.identity.worktreeId = 'other'
      }
      if (change === 'leaf' && terminal.presentation) {
        terminal.presentation.identity.leafId = 'other'
      }
      return { terminal }
    })
    expect(await captureSourceTerminal(source(PTY_ID))).toBeNull()
    if (change === 'incarnation') {
      expect(rpc).toHaveResolvedWith({ terminal: resolvedTerminal })
      expect(resolvedTerminal).toMatchObject({ ptyId: PTY_ID, incarnationId: INCARNATION_ID })
      expect(resolvedTerminal).not.toHaveProperty('presentation')
    }
  }
)

it('keeps remote proxy and host PTY namespaces distinct, and refuses absent or changed remote owners', async () => {
  const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
  seed(harness)
  const terminal = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  const proxy = toRemoteRuntimePtyId(terminal.handle, 'paired')
  useAppStore.setState({
    terminalLayoutsByTabId: {
      ...useAppStore.getState().terminalLayoutsByTabId,
      [TAB_ID]: {
        ...useAppStore.getState().terminalLayoutsByTabId[TAB_ID],
        ptyIdsByLeafId: { [LEAF_ID]: proxy }
      }
    }
  })
  rpc.mockResolvedValue({ terminal })
  expect(await captureSourceTerminal(source(proxy, 'runtime:paired'))).toMatchObject({
    target: { kind: 'environment', environmentId: 'paired' },
    handle: terminal.handle
  })
  expect(
    await captureSourceTerminal(source(toRemoteRuntimePtyId(terminal.handle), 'runtime:paired'))
  ).toBeNull()
  expect(await captureSourceTerminal(source(undefined, 'runtime:paired'))).toBeNull()
  expect(await captureSourceTerminal(source(proxy, 'local'))).toBeNull()
  terminal.handle = 'different'
  expect(await captureSourceTerminal(source(proxy, 'runtime:paired'))).toBeNull()
  expect(rpc).toHaveBeenCalledTimes(2)
})

it('requires a real row/leaf for the new missing-binding exception while retaining existing nonnull-source admission', async () => {
  const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
  const terminal = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  rpc.mockResolvedValue({ terminal })
  expect(await captureSourceTerminal(source(undefined))).toBeNull()
  expect(await captureSourceTerminal(source(PTY_ID))).toMatchObject({ handle: terminal.handle })
  const proxy = toRemoteRuntimePtyId(terminal.handle, 'paired')
  expect(await captureSourceTerminal(source(proxy, 'runtime:paired'))).toMatchObject({
    handle: terminal.handle
  })
})
