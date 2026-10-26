// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { captureTerminalSurfaceIdentity } from '../../../../shared/terminal-tab-close'
import type * as PtyDispatcherModule from '../terminal-pane/pty-dispatcher'
import { TerminalClose } from '../../../../shared/rpc-contract/terminal-unary-params'
import type { TerminalPaneCloseCallbacks } from '@/constants/terminal'
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  supportsPinCloseConsent: true,
  request: vi.fn(),
  exit: vi.fn(),
  subscribe: vi.fn(),
  reveal: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/lib/reveal-terminal-pane', () => ({ revealTerminalPane: mocks.reveal }))
vi.mock('../terminal-pane/request-active-terminal-pane-close', () => ({
  requestActiveTerminalPaneClose: mocks.request
}))
vi.mock('../terminal-pane/terminal-delivery-watchdog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startTerminalDeliveryWatchdog: vi.fn()
}))
vi.mock('../terminal-pane/terminal-freeze-report', () => ({ installTerminalFreezeReport: vi.fn() }))
vi.mock('../terminal-pane/pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof PtyDispatcherModule>()
  mocks.subscribe.mockImplementation(actual.subscribeToPtyExit)
  return { ...actual, subscribeToPtyExit: mocks.exit }
})
import type { HeldTerminalTarget } from './native-chat-held-terminal'
import { closeHoldingTerminal, HOLDING_TERMINAL_EXIT_TIMEOUT_MS } from './close-holding-terminal'
const original = useAppStore.getState()
const target = {
  executionHostId: 'local' as const,
  worktreeId: 'w',
  tabId: 't',
  leafId: '11111111-1111-4111-8111-111111111111',
  paneKey: 't:11111111-1111-4111-8111-111111111111',
  ptyId: 'pty',
  incarnationId: 'life',
  title: 'Build'
}
let callbacks: TerminalPaneCloseCallbacks
let exit: (code: number, context: { hadPrimary: boolean; incarnationId?: string }) => void
let spawned: (event: { id: string; incarnationId?: string }) => void
let dispatchExit: (payload: { id: string; code: number; incarnationId?: string }) => void
let frame: FrameRequestCallback
let closing: ReturnType<typeof Promise.withResolvers<{ close: { ptyKilled: boolean } }>>
const unsubscribe = vi.fn()
const activeWatchers = new Set<() => void>()
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.supportsPinCloseConsent = true
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    frame = run
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('api', {
    pty: {
      onSpawned: (listener: typeof spawned) => {
        spawned = listener
        return () => {}
      },
      onData: () => () => {},
      onReplay: () => () => {},
      onExit: (listener: typeof dispatchExit) => {
        dispatchExit = listener
        return () => {}
      }
    }
  })
  useAppStore.setState({
    activeWorktreeId: 'origin',
    activeWorkspaceExecutionHostId: 'local',
    activeView: 'terminal',
    tabsByWorktree: {
      w: [
        {
          id: 't',
          worktreeId: 'w',
          title: 'Build',
          customTitle: null,
          ptyId: 'pty',
          color: null,
          createdAt: 1,
          sortOrder: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      t: {
        root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
        activeLeafId: '11111111-1111-4111-8111-111111111111',
        expandedLeafId: null,
        ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': 'pty' }
      }
    },
    terminalPtyIncarnationsByPaneKey: {},
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    setActiveWorktree: (id, host) =>
      useAppStore.setState({ activeWorktreeId: id, activeWorkspaceExecutionHostId: host ?? null }),
    setActiveView: (view) => useAppStore.setState({ activeView: view })
  })
  closing = Promise.withResolvers()
  mocks.rpc.mockImplementation(async (_target, method) => {
    if (method === 'terminal.close') {
      return closing.promise
    }
    const identity = captureTerminalSurfaceIdentity(
      useAppStore.getState(),
      'w',
      useAppStore.getState().tabsByWorktree.w[0].id,
      '11111111-1111-4111-8111-111111111111'
    )
    return {
      terminal: {
        handle: 'handle',
        ptyId: 'pty',
        incarnationId: 'life',
        supportsPinCloseConsent: mocks.supportsPinCloseConsent,
        presentation: {
          identity: { ...identity, tabId: 't', ptyId: 'pty', incarnationId: 'life' },
          holders: []
        }
      }
    }
  })
  mocks.request.mockImplementation((_tab, options) => {
    callbacks = options
    return true
  })
  mocks.exit.mockImplementation((pty, listener) => {
    const stopReal = mocks.subscribe(
      pty,
      (code: number, context: { hadPrimary: boolean; incarnationId?: string }) => {
        activeWatchers.delete(stop)
        listener(code, context)
      }
    )
    const stop = () => {
      stopReal()
      activeWatchers.delete(stop)
      unsubscribe()
    }
    activeWatchers.add(stop)
    exit = (code, context) => dispatchExit({ id: pty, code, incarnationId: context.incarnationId })
    return stop
  })
  mocks.reveal.mockImplementation(() => {
    if (!useAppStore.getState().isNavigatingHistory) {
      useAppStore.getState().recordWorktreeVisit('w')
    }
    useAppStore.setState({ activeWorktreeId: 'w' })
    return true
  })
  replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 1 }])
})
afterEach(() => {
  useAppStore.setState(original)
  activeWatchers.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function begin(input: HeldTerminalTarget = target) {
  const reveals = mocks.reveal.mock.calls.length
  const result = closeHoldingTerminal(input)
  await vi.waitFor(() => expect(mocks.reveal).toHaveBeenCalledTimes(reveals + 1))
  frame(0)
  return { result }
}
it('uses host-captured incarnation without a renderer map, subscribes before consent, and restores origin while awaiting actual exit', async () => {
  const history = useAppStore.getState().worktreeNavHistory
  const { result } = await begin()
  expect(useAppStore.getState().worktreeNavHistory).toBe(history)
  expect(mocks.exit.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.request.mock.invocationCallOrder[0]
  )
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
  callbacks.onConfirm?.()
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    { kind: 'local' },
    'terminal.close',
    expect.objectContaining({
      terminal: 'handle',
      expectedIncarnationId: 'life',
      originalPresentation: expect.any(Object)
    })
  )
  expect(useAppStore.getState().activeWorktreeId).toBe('origin')
  useAppStore.setState({ tabsByWorktree: {} })
  exit(0, { hadPrimary: false, incarnationId: 'replacement' })
  expect(activeWatchers.size).toBe(1)
  exit(0, { hadPrimary: false, incarnationId: 'life' })
  expect(await result).toBe(true)
  expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual([
    'terminal.resolvePane',
    'terminal.close'
  ])
  expect(vi.getTimerCount()).toBe(0)
})
it.each(['cancel', 'replace', 'navigate', 'timeout', 'host-loss', 'spawn'] as const)(
  'settles %s without a follow-up or stolen navigation',
  async (outcome) => {
    const { result } = await begin()
    if (outcome === 'spawn') {
      spawned({ id: 'pty', incarnationId: 'replacement' })
    }
    if (outcome === 'cancel') {
      callbacks.onCancel?.()
    }
    if (outcome === 'replace') {
      useAppStore.setState({
        terminalPtyIncarnationsByPaneKey: { 't:11111111-1111-4111-8111-111111111111': 'new' }
      })
      expect(callbacks.isCurrent?.()).toBe(false)
      callbacks.onConfirm?.()
    }
    if (outcome === 'navigate') {
      useAppStore.setState({ activeWorktreeId: 'later' })
    }
    if (outcome === 'host-loss') {
      callbacks.onConfirm?.()
      exit(-1, { hadPrimary: false, incarnationId: 'life' })
    }
    if (outcome === 'timeout') {
      callbacks.onConfirm?.()
      await vi.advanceTimersByTimeAsync(HOLDING_TERMINAL_EXIT_TIMEOUT_MS)
    }
    expect(await result).toBe(false)
    expect(useAppStore.getState().activeWorktreeId).toBe(
      outcome === 'navigate' ? 'later' : 'origin'
    )
    expect(mocks.rpc).toHaveBeenCalledTimes(
      outcome === 'timeout' || outcome === 'host-loss' ? 2 : 1
    )
    expect(vi.getTimerCount()).toBe(0)
  }
)
it.each([true, false])(
  'fences paired completion without requiring removed presentation, replaced=%s',
  async (replaced) => {
    const paired = {
      ...target,
      executionHostId: 'runtime:host' as const,
      tabId: 'web-terminal-t',
      paneKey: `web-terminal-${target.paneKey}`,
      ptyId: 'remote:host@@handle'
    }
    useAppStore.setState({
      tabsByWorktree: {
        w: useAppStore.getState().tabsByWorktree.w.map((tab) => ({ ...tab, id: paired.tabId }))
      },
      terminalLayoutsByTabId: {
        [paired.tabId]: {
          ...useAppStore.getState().terminalLayoutsByTabId.t,
          ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': paired.ptyId }
        }
      }
    })
    const call = vi
      .fn()
      .mockImplementation(async () => ({ ok: true, result: await closing.promise }))
    vi.stubGlobal('api', { runtimeEnvironments: { call } })
    const { result } = await begin(paired)
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host' },
      'terminal.resolvePane',
      { paneKey: target.paneKey, worktreeId: 'w' }
    )
    callbacks.onConfirm?.(true)
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'host',
        expectedEnvironmentPairingRevision: 1,
        method: 'terminal.close',
        params: expect.objectContaining({ force: true })
      })
    )
    useAppStore.setState({ tabsByWorktree: {} })
    if (replaced) {
      replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 2 }])
    }
    closing.resolve({ close: { ptyKilled: true } })
    expect(await result).toBe(!replaced)
  }
)
it.each([1, 10])(
  'releases every preconsent observer/frame for %s cancelled attempts',
  async (count) => {
    for (let i = 0; i < count; i++) {
      const { result } = await begin()
      callbacks.onCancel?.()
      expect(await result).toBe(false)
    }
    expect(mocks.exit).toHaveBeenCalledTimes(count)
    expect(unsubscribe).toHaveBeenCalledTimes(count)
    expect(activeWatchers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('restores the invoking chat through its real tab consumer and preserves later user selection', async () => {
  const chat = useAppStore
    .getState()
    .createUnifiedTab('origin', 'agent-session', { entityId: 'chat', executionHostId: 'local' })
  useAppStore.getState().activateTab(chat.id, { worktreeId: 'origin' })
  const { result } = await begin()
  callbacks.onConfirm?.()
  expect(
    useAppStore.getState().groupsByWorktree.origin.find((group) => group.id === chat.groupId)
      ?.activeTabId
  ).toBe(chat.id)
  const later = useAppStore.getState().createUnifiedTab('origin', 'agent-session', {
    entityId: 'later-chat',
    executionHostId: 'local'
  })
  useAppStore.getState().activateTab(later.id, { worktreeId: 'origin' })
  closing.resolve({ close: { ptyKilled: true } })
  expect(await result).toBe(true)
  expect(
    useAppStore.getState().groupsByWorktree.origin.find((group) => group.id === later.groupId)
      ?.activeTabId
  ).toBe(later.id)
})

it('emits only effective literal consent on the captured parser/handler contract', async () => {
  const { result } = await begin()
  callbacks.onConfirm?.(true)
  const params = mocks.rpc.mock.calls.find(([, method]) => method === 'terminal.close')?.[2]
  expect(params).toMatchObject({ terminal: 'handle', expectedIncarnationId: 'life', force: true })
  expect(TerminalClose.parse(params)).toEqual(params)
  for (const force of [false, null, 'true']) {
    expect(TerminalClose.safeParse({ ...params, force }).success).toBe(false)
  }
  expect(TerminalClose.safeParse({ terminal: 'handle', force: true }).success).toBe(false)
  expect(TerminalClose.safeParse({ ...params, expectedIncarnationId: undefined }).success).toBe(
    false
  )
  expect(TerminalClose.safeParse({ ...params, originalPresentation: undefined }).success).toBe(
    false
  )
  expect(TerminalClose.parse({ terminal: 'handle' })).toEqual({ terminal: 'handle' })
  closing.resolve({ close: { ptyKilled: true } })
  expect(await result).toBe(true)
})
it('fresh unsupported capture refuses before reveal or confirmation', async () => {
  mocks.supportsPinCloseConsent = false
  expect(await closeHoldingTerminal(target)).toBe(false)
  expect(mocks.reveal).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalled()
})
