// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  useNativeChatSignIn,
  type NativeChatHostSetupInput
} from './use-native-chat-account-sign-in'
import type { NativeChatHostCommandTerminal } from './native-chat-host-command-terminal'

type FixtureState = {
  settings: Record<string, unknown>
  ptyIdsByTabId: Record<string, string[] | undefined>
  tabsByWorktree: Record<string, { id: string }[] | undefined>
  fetchSettings: () => Promise<void>
}

const { store, hostSupports, modelCatalog } = vi.hoisted(() => {
  type Listener = (state: FixtureState, previous: FixtureState) => void
  const listeners = new Set<Listener>()
  let state: FixtureState = {
    settings: {},
    ptyIdsByTabId: {},
    tabsByWorktree: {},
    fetchSettings: async () => {}
  }
  const store = {
    reset(next: FixtureState) {
      state = next
      listeners.clear()
    },
    get: (): FixtureState => state,
    set(patch: Partial<FixtureState>) {
      const previous = state
      state = { ...state, ...patch }
      listeners.forEach((listener) => listener(state, previous))
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return {
    store,
    hostSupports: vi.fn(async () => true),
    modelCatalog: vi.fn()
  }
})

vi.mock('@/store/index', () => ({
  useAppStore: Object.assign((select: (state: FixtureState) => unknown) => select(store.get()), {
    getState: () => store.get(),
    subscribe: (listener: (state: FixtureState, previous: FixtureState) => void) =>
      store.subscribe(listener)
  })
}))
vi.mock('@/store/slices/runtime-status/views/use-runtime-status-view', () => ({
  useAppStoreWithHostStatuses: (
    select: (state: FixtureState, statuses: Map<string, never>) => unknown
  ) => select(store.get(), new Map<string, never>())
}))
vi.mock('@/app-shell/platform/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'darwin'
}))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  structuredAgentSessionHostSupports: hostSupports
}))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: modelCatalog
}))

function input(overrides: Partial<NativeChatHostSetupInput> = {}): NativeChatHostSetupInput {
  return {
    agent: 'codex',
    target: { kind: 'local' },
    worktreeId: 'folder',
    sessionId: 'chat',
    isVisible: true,
    failureKey: 'original',
    needsSignIn: true,
    account: 'system',
    failure: null,
    startFailures: [],
    journalItems: [],
    onRechecked: () => {},
    ...overrides
  }
}

function fakeTerminal(): NativeChatHostCommandTerminal & {
  open: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
} {
  let opened = 0
  const open = vi.fn(async () => {
    const tabId = `login-${++opened}`
    const state = store.get()
    store.set({
      tabsByWorktree: {
        folder: [...(state.tabsByWorktree.folder ?? []), { id: tabId }]
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, [tabId]: [`pty-${tabId}`] }
    })
    return { tabId }
  })
  const show = vi.fn((tabId: string) =>
    Boolean(store.get().tabsByWorktree.folder?.some((tab) => tab.id === tabId))
  )
  return { opening: false, open, show }
}

function closeTab(tabId: string) {
  const state = store.get()
  store.set({
    tabsByWorktree: {
      folder: state.tabsByWorktree.folder?.filter((tab) => tab.id !== tabId)
    },
    ptyIdsByTabId: { ...state.ptyIdsByTabId, [tabId]: undefined }
  })
}

beforeEach(() => {
  store.reset({
    settings: {},
    ptyIdsByTabId: {},
    tabsByWorktree: { folder: [] },
    fetchSettings: vi.fn(async () => {})
  })
  hostSupports.mockResolvedValue(true)
  modelCatalog.mockResolvedValue({ origin: 'probe', models: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('signs in the chat account once, without sending, and offers recovery for a new failure', async () => {
  let complete!: () => void
  const login = vi.fn(() => new Promise<void>((resolve) => (complete = resolve)))
  const send = vi.fn()
  Object.assign(window, {
    api: {
      codexAccounts: {
        chatSignInAccount: async () => 'chat-account',
        reauthenticate: login
      },
      agentSessions: { send }
    }
  })
  const signedIn = vi.fn()
  const { result, rerender } = renderHook(
    (props: { failureKey: string }) =>
      useNativeChatSignIn(
        input({
          account: 'managed',
          failureKey: props.failureKey,
          onSignInRechecked: signedIn
        }),
        null
      ),
    { initialProps: { failureKey: 'original' } }
  )
  await waitFor(() => expect(result.current.signIn?.signIn).toBeTypeOf('function'))
  act(() => {
    result.current.signIn?.signIn()
    result.current.signIn?.signIn()
  })
  expect(login).toHaveBeenCalledOnce()
  expect(login).toHaveBeenCalledWith({
    accountId: 'chat-account',
    sessionId: 'chat'
  })
  expect(result.current.signIn?.signingIn).toBe(true)
  await act(async () => complete())
  await waitFor(() => expect(result.current.resolved).toBe(true))
  expect(result.current.announcement).toBe('Signed in.')
  expect(signedIn).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled()
  expect(modelCatalog).not.toHaveBeenCalled()
  rerender({ failureKey: 'new-failure' })
  await waitFor(() => expect(result.current.signIn).toMatchObject({ signedIn: false }))
  expect(result.current.resolved).toBe(false)
  expect(result.current.announcement).toBe('')
})

it('offers Check again after a failed account lookup and recovers on retry', async () => {
  const lookup = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue('chat-account')
  Object.assign(window, {
    api: {
      codexAccounts: { chatSignInAccount: lookup, reauthenticate: vi.fn() }
    }
  })
  const terminal = fakeTerminal()
  const { result } = renderHook(() => useNativeChatSignIn(input({ account: 'managed' }), terminal))
  await waitFor(() => expect(result.current.signIn).toMatchObject({ lookupFailed: true }))
  act(() => result.current.signIn?.signIn())
  await waitFor(() => expect(result.current.signIn).toMatchObject({ signingIn: false }))
  expect(result.current.signIn?.lookupFailed).toBeUndefined()
  expect(lookup).toHaveBeenCalledTimes(2)
  // A managed account never falls back to a terminal login.
  expect(terminal.open).not.toHaveBeenCalled()
})

it.each([
  ['an unsupported host', false, undefined],
  ['an unconfirmed result', true, { origin: 'probe', models: [] }]
])(
  'stays silent after a terminal sign-in on %s and keeps the launch Retry reachable',
  async (_case, supported, catalog) => {
    hostSupports.mockResolvedValue(supported)
    modelCatalog.mockResolvedValue(catalog)
    const terminal = fakeTerminal()
    const signedIn = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatSignIn(input({ onSignInRechecked: signedIn }), terminal)
    )
    await act(async () => result.current.signIn?.signIn())
    expect(terminal.open).toHaveBeenCalledOnce()
    expect(result.current.signIn).toMatchObject({
      signingIn: false,
      unconfirmed: true
    })
    // A repeat press returns to the open login terminal instead of opening another.
    await act(async () => result.current.signIn?.signIn())
    expect(terminal.show).toHaveBeenCalledWith('login-1')
    expect(terminal.open).toHaveBeenCalledOnce()
    await act(async () => closeTab('login-1'))
    await act(async () => {})
    expect(result.current.resolved).toBe(false)
    expect(result.current.announcement).toBe('')
    expect(result.current.signIn).toMatchObject({
      signedIn: false,
      unconfirmed: true
    })
    expect(signedIn).not.toHaveBeenCalled()
    // Once that terminal is gone, Sign in opens a fresh one.
    await act(async () => result.current.signIn?.signIn())
    expect(terminal.open).toHaveBeenCalledTimes(2)
  }
)

it('says Signed in only when the host confirms the terminal sign-in', async () => {
  modelCatalog.mockResolvedValue({
    origin: 'probe',
    models: [],
    signInConfirmed: true
  })
  const terminal = fakeTerminal()
  const signedIn = vi.fn()
  const { result } = renderHook(() =>
    useNativeChatSignIn(input({ onSignInRechecked: signedIn }), terminal)
  )
  await act(async () => result.current.signIn?.signIn())
  await act(async () => closeTab('login-1'))
  await waitFor(() => expect(result.current.resolved).toBe(true))
  expect(modelCatalog).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.modelCatalog', {
    agent: 'codex',
    sessionId: 'chat',
    confirmSignIn: true
  })
  expect(result.current.announcement).toBe('Signed in.')
  expect(result.current.signIn).not.toHaveProperty('unconfirmed')
  expect(signedIn).toHaveBeenCalledOnce()
})

it('ignores another tab closing while its own login terminal is open', async () => {
  modelCatalog.mockResolvedValue({
    origin: 'probe',
    models: [],
    signInConfirmed: true
  })
  const terminal = fakeTerminal()
  const { result } = renderHook(() => useNativeChatSignIn(input(), terminal))
  await act(async () => result.current.signIn?.signIn())
  await act(async () => {
    const state = store.get()
    store.set({
      tabsByWorktree: {
        folder: [...(state.tabsByWorktree.folder ?? []), { id: 'other' }]
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, other: ['pty-other'] }
    })
  })
  await act(async () => closeTab('other'))
  expect(modelCatalog).not.toHaveBeenCalled()
  expect(result.current.resolved).toBe(false)
})
