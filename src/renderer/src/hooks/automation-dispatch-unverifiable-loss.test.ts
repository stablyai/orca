import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchResult } from '../../../shared/automations-types'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'
import type { createTestStore } from '@/store/slices/store-test-helpers'

let bindingStore: ReturnType<typeof createTestStore> | null = null

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => bindingStore?.getState() ?? { agentStatusByPaneKey: {} },
    subscribe: vi.fn(() => () => {})
  }
}))

const markDispatchResult = vi.fn<(result: AutomationDispatchResult) => Promise<void>>()
const releaseTerminalOwnership = vi.fn()
const finalizeTerminalOwnership = vi.fn<AutomationTerminalOwnership['finalize']>(async () => null)

async function createCompletion() {
  const { createAutomationDispatchCompletion } = await import('./automation-dispatch-completion')
  const completion = createAutomationDispatchCompletion({
    run: { id: 'run-1' } as never,
    worktree: { id: 'wt-1', displayName: 'Automation worktree' } as never,
    precheckResult: null,
    markDispatchResult,
    releaseTerminalOwnership,
    finalizeTerminalOwnership
  })
  await completion.settlePendingAfterDispatch()
  markDispatchResult.mockClear()
  return completion
}

/**
 * Loss of contact is never evidence of process death
 * (docs/reference/ssh-execution-boundary.md). The exit sentinel these readers
 * receive is the same one the terminal panes already classify as unverifiable.
 */
describe('automation dispatch completion on an unverifiable loss', () => {
  beforeEach(() => {
    bindingStore = null
    vi.clearAllMocks()
    markDispatchResult.mockResolvedValue(undefined)
    finalizeTerminalOwnership.mockResolvedValue(null)
  })

  it('records no result, so the run keeps its non-final dispatched status', async () => {
    // Exit -1 is unobserved relay/host loss, never a witnessed finish; SSH work may still run.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const completion = await createCompletion()

    completion.handleExit(-1)
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())

    expect(markDispatchResult).not.toHaveBeenCalled()
    // Closing a terminal whose process cannot be proven dead orphans live work.
    expect(finalizeTerminalOwnership).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('still completes and finalizes a genuinely exited process', async () => {
    const completion = await createCompletion()
    finalizeTerminalOwnership.mockResolvedValue('closed')

    completion.handleExit(0)
    await vi.waitFor(() => expect(finalizeTerminalOwnership).toHaveBeenCalledOnce())

    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', status: 'completed', error: null })
    )
    expect(releaseTerminalOwnership).not.toHaveBeenCalled()
  })

  it('still reports a real automation failure as dispatch_failed', async () => {
    const completion = await createCompletion()

    completion.handleExit(9)
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())

    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatch_failed',
        error: 'Automation process exited with code 9.'
      })
    )
    expect(finalizeTerminalOwnership).not.toHaveBeenCalled()
  })

  it('lets a later done still complete a run whose contact was lost', async () => {
    // Loss withholds judgment; later positive evidence must still finish the run.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const completion = await createCompletion()

    completion.handleExit(-1)
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())
    completion.handleAgentDone()

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      )
    )
    warnSpy.mockRestore()
  })

  it.each([
    'pending exit',
    'pending done',
    'exit persistence',
    'done persistence',
    'ordinary completion'
  ] as const)('conserves real unselected terminal ownership through %s', async (phase) => {
    const { createTestStore, seedStore, makeWorktree, TEST_REPO } =
      await import('@/store/slices/store-test-helpers')
    const { makeRun } = await import('@/components/automations/automations-page-fixtures')
    const { createAutomationTerminalOwnership } =
      await import('@/lib/automation-terminal-ownership')
    const { createAutomationDispatchCompletion } = await import('./automation-dispatch-completion')
    vi.stubGlobal('window', { api: { pty: { kill: vi.fn(async () => {}) } } })
    try {
      const store = createTestStore()
      bindingStore = store
      const worktree = makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'local' })
      seedStore(store, { worktreesByRepo: { [TEST_REPO.id]: [worktree] } })
      const selected = store.getState().createTab(worktree.id, undefined, undefined, {
        initialPtyId: 'pty-C'
      })
      const tab = store.getState().createTab(worktree.id, undefined, undefined, {
        initialPtyId: 'pty-B',
        activate: false,
        recordInteraction: false
      })
      store.getState().updateTabPtyId(tab.id, 'pty-B')
      store.setState({
        activeWorktreeId: worktree.id,
        activeTabId: selected.id,
        activeTabType: 'terminal'
      })
      const layout = store.getState().terminalLayoutsByTabId[tab.id]
      const leafId = layout.activeLeafId
      if (!leafId) {
        throw new Error('Background terminal has no active leaf')
      }
      const paneKey = `${tab.id}:${leafId}`
      const ownership = createAutomationTerminalOwnership({
        store,
        worktreeId: worktree.id,
        tabId: tab.id,
        paneKey,
        ptyId: 'pty-B',
        tabCreatedAt: tab.createdAt,
        runtimeKind: 'desktop'
      })
      const pendingDispatch = phase === 'pending exit' || phase === 'pending done'
      let acquiredOwnership: AutomationTerminalOwnership | null = pendingDispatch ? null : ownership
      const release = vi.fn(() => acquiredOwnership?.release())
      const finalize = vi.fn<AutomationTerminalOwnership['finalize']>((options) =>
        ownership.finalize(options)
      )
      const close = vi.spyOn(store.getState(), 'closeTab')
      const hibernate = vi.spyOn(store.getState(), 'shutdownCompletedAgentPaneForHibernation')
      let finishResult!: () => void
      const persistence = new Promise<void>((resolve) => {
        finishResult = resolve
      })
      markDispatchResult.mockReturnValueOnce(persistence)
      const completion = createAutomationDispatchCompletion({
        run: makeRun({ status: 'dispatched', workspaceId: worktree.id }),
        worktree,
        precheckResult: null,
        markDispatchResult,
        releaseTerminalOwnership: release,
        finalizeTerminalOwnership: finalize
      })
      const exitOptions = { preserveRendererBinding: 'closing' as const }
      let settlement: Promise<void> | undefined
      if (pendingDispatch) {
        if (phase === 'pending done') {
          completion.handleAgentDone()
        }
        completion.handleExit(0, exitOptions)
        acquiredOwnership = ownership
        settlement = completion.settlePendingAfterDispatch()
      } else {
        await completion.settlePendingAfterDispatch()
        if (phase === 'done persistence') {
          completion.handleAgentDone()
        } else {
          completion.handleExit(0)
        }
        if (phase !== 'ordinary completion') {
          completion.handleExit(0, exitOptions)
        }
      }
      expect(markDispatchResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ runId: 'run-1', status: 'completed', error: null })
      )
      expect(close).not.toHaveBeenCalled()
      expect(hibernate).not.toHaveBeenCalled()
      expect(store.getState().activeTabId).toBe(selected.id)
      expect(store.getState().lastTerminalInputAtByPaneKey[paneKey]).toBeUndefined()
      finishResult()
      await settlement
      await vi.waitFor(() =>
        expect(finalize).toHaveBeenCalledExactlyOnceWith({ preservePane: false })
      )
      if (phase === 'ordinary completion') {
        await vi.waitFor(() => expect(markDispatchResult).toHaveBeenCalledTimes(2))
        expect(close).toHaveBeenCalledExactlyOnceWith(tab.id, {
          recordInteraction: false,
          reason: 'cleanup'
        })
        expect(store.getState().tabsByWorktree[worktree.id].some((t) => t.id === tab.id)).toBe(
          false
        )
        expect(store.getState().ptyIdsByTabId[tab.id]).toBeUndefined()
        expect(release).not.toHaveBeenCalled()
      } else {
        expect(markDispatchResult).toHaveBeenCalledOnce()
        expect(close).not.toHaveBeenCalled()
        expect(store.getState().tabsByWorktree[worktree.id].find((t) => t.id === tab.id)).toBe(tab)
        expect(store.getState().ptyIdsByTabId[tab.id]).toEqual(['pty-B'])
        expect(store.getState().terminalLayoutsByTabId[tab.id]).toBe(layout)
        expect(store.getState().lastKnownRelayPtyIdByTabId[tab.id]).toBe('pty-B')
        expect(release).toHaveBeenCalled()
      }
      expect(hibernate).not.toHaveBeenCalled()
      expect(store.getState().tabsByWorktree[worktree.id].find((t) => t.id === selected.id)).toBe(
        selected
      )
      expect(store.getState().activeTabId).toBe(selected.id)
      expect(store.getState().lastTerminalInputAtByPaneKey[paneKey]).toBeUndefined()
      ownership.release()
    } finally {
      bindingStore = null
      vi.unstubAllGlobals()
    }
  })
})
