// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store'
import { resolveHeldTerminalTarget } from './native-chat-held-terminal'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { NativeChatOrcaStopContext } from './native-chat-orca-stop-context'
const mocks = vi.hoisted(() => ({ reveal: vi.fn(), capture: vi.fn(), close: vi.fn() }))
vi.mock('@/lib/reveal-terminal-pane', () => ({ revealTerminalPane: mocks.reveal }))
vi.mock('./close-holding-terminal', () => ({
  captureHeldTerminal: mocks.capture,
  closeHoldingTerminal: mocks.close
}))
const leaf = '11111111-1111-4111-8111-111111111111'
const original = useAppStore.getState()
const terminal = { paneKey: `terminal:${leaf}`, worktreeId: 'w', incarnationId: 'life' }
const view = {
  hostLabel: null,
  remoteHost: false,
  continueAvailable: false,
  offeredTurnItemId: null,
  continueNow: () => {},
  usageLimitTurnItemId: null,
  continueUsageLimit: () => {},
  heldTerminal: { executionHostId: 'local' as const }
}
const block = {
  type: 'text' as const,
  text: 'Unnamed fallback',
  failure: { kind: 'conversationOpenInTerminal' as const },
  heldByTerminal: terminal
}
const spawned = new Set<(event: { id: string; incarnationId?: string }) => void>()
beforeEach(() => {
  vi.clearAllMocks()
  mocks.capture.mockResolvedValue({ incarnationId: 'life', supportsPinCloseConsent: true })
  vi.stubGlobal('api', {
    pty: {
      onSpawned: (fn: (event: { id: string; incarnationId?: string }) => void) => {
        spawned.add(fn)
        return () => spawned.delete(fn)
      },
      onExit: () => () => {}
    }
  })
  useAppStore.setState({
    tabsByWorktree: {
      w: [
        {
          id: 'terminal',
          worktreeId: 'w',
          title: 'Shell',
          customTitle: 'Review',
          ptyId: 'pty',
          color: null,
          createdAt: 1,
          sortOrder: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      terminal: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: 'pty' }
      }
    }
  })
  useAppStore
    .getState()
    .createUnifiedTab('w', 'terminal', { entityId: 'terminal', executionHostId: 'local' })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(original)
  vi.unstubAllGlobals()
  expect(spawned.size).toBe(0)
})
function notice(holder = terminal) {
  return render(
    <NativeChatOrcaStopContext.Provider value={view}>
      <NativeChatNoticeRow
        block={{ ...block, heldByTerminal: holder }}
        agentName="Codex"
        messageId="notice"
      />
    </NativeChatOrcaStopContext.Provider>
  )
}
it('names and reveals only the verified original; a replacement immediately restores the generic notice', async () => {
  expect(resolveHeldTerminalTarget(useAppStore.getState(), terminal, 'runtime:other')).toBeNull()
  notice()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review' })).toBeDefined())
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))
  await waitFor(() => expect(mocks.reveal).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: 'Close terminal' })).toBeDefined()
  act(() => {
    for (const fn of spawned) {
      fn({ id: 'pty', incarnationId: 'new-life' })
    }
  })
  expect(screen.getByText('Unnamed fallback')).toBeDefined()
  expect(screen.queryByRole('button')).toBeNull()
})
it.each([10, 100])(
  'does no target discovery on %s unrelated publications, updates relevant titles and releases subscriptions',
  async (count) => {
    const tabs = useAppStore.getState().tabsByWorktree.w
    const find = vi.spyOn(tabs, 'find')
    const mounted = notice()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review' })).toBeDefined())
    find.mockClear()
    mocks.capture.mockClear()
    act(() => {
      for (let i = 0; i < count; i++) {
        useAppStore.setState({
          terminalLayoutsByTabId: {
            ...useAppStore.getState().terminalLayoutsByTabId,
            unrelated: { root: null, activeLeafId: null, expandedLeafId: null }
          }
        })
      }
    })
    expect(find).not.toHaveBeenCalled()
    expect(mocks.capture).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        tabsByWorktree: { w: tabs.map((tab) => ({ ...tab, customTitle: 'Renamed' })) }
      })
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Renamed' })).toBeDefined())
    mounted.unmount()
    expect(spawned.size).toBe(0)
  }
)
it('keeps legacy metadata generic without a host lookup', () => {
  notice({ ...terminal, incarnationId: '' })
  expect(screen.getByText('Unnamed fallback')).toBeDefined()
  expect(mocks.capture).not.toHaveBeenCalled()
})

it('keeps Close busy for one attempt, then clears without submitting another action', async () => {
  const closed = Promise.withResolvers<boolean>()
  mocks.close.mockReturnValueOnce(closed.promise)
  notice()
  const button = await screen.findByRole('button', { name: 'Close terminal' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(mocks.close).toHaveBeenCalledOnce()
  expect(button).toHaveProperty('disabled', true)
  await act(async () => closed.resolve(true))
  expect(button).toHaveProperty('disabled', false)
  expect(mocks.close).toHaveBeenCalledOnce()
  expect(mocks.reveal).not.toHaveBeenCalled()
})

it.each([undefined, false, 'true'])(
  'retains verified naming/link with unsupported consent %s and withholds only Close',
  async (support) => {
    mocks.capture.mockResolvedValue({ incarnationId: 'life', supportsPinCloseConsent: support })
    notice()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review' })).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Close terminal' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(mocks.reveal).toHaveBeenCalledOnce())
    expect(mocks.close).not.toHaveBeenCalled()
  }
)
