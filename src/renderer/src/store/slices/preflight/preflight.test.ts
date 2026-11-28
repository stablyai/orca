import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => {
  const focus: {
    contextKey: string
    owner: { kind: 'environment'; environmentId: string } | null
  } = { contextKey: 'ctx-a', owner: null }
  return { focus, rpc: vi.fn() }
})

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/hosts/selection/default-creation-host', () => ({
  defaultScopeHost: () => ({ kind: 'local' })
}))
vi.mock('@/lib/workspace/ownership/resolved-worktree-execution-host', () => ({
  getActiveWorkspaceOwnerTarget: () => mocks.focus.owner
}))
vi.mock('@/runtime/hosts/preflight/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({})
}))
vi.mock('@/runtime/hosts/preflight/local-preflight-context-key', () => ({
  localPreflightContextKey: () => mocks.focus.contextKey
}))

const STATUS = { bitbucket: { configured: true, authenticated: true, account: 'dev' } }

function createStore(): typeof useAppStore {
  useAppStore.setState(useAppStore.getInitialState(), true)
  return useAppStore
}

describe('preflight status host', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.focus.contextKey = 'ctx-a'
    mocks.focus.owner = null
    vi.stubGlobal('window', { api: { preflight: { check: vi.fn().mockResolvedValue(STATUS) } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('records the host an answer came from together with its context key', async () => {
    const wsl = { kind: 'environment' as const, environmentId: 'wsl-host' }
    mocks.focus.owner = wsl
    mocks.rpc.mockResolvedValue(STATUS)
    const store = createStore()

    await store.getState().refreshPreflightStatus()

    expect(mocks.rpc).toHaveBeenCalledWith(wsl, 'preflight.check', {})
    expect(store.getState().preflightStatusContextKey).toBe('ctx-a')
    expect(store.getState().preflightStatusHost).toEqual({ target: wsl, followsWorkspace: true })
  })

  it('drops the old host as soon as the context changes, before the new answer lands', async () => {
    const store = createStore()
    await store.getState().refreshPreflightStatus()
    expect(store.getState().preflightStatusHost).toEqual({
      target: { kind: 'local' },
      followsWorkspace: false
    })

    mocks.focus.contextKey = 'ctx-b'
    mocks.focus.owner = { kind: 'environment', environmentId: 'wsl-host' }
    mocks.rpc.mockReturnValue(new Promise(() => {}))
    void store.getState().refreshPreflightStatus()

    expect(store.getState().preflightStatusHost).toBeNull()
  })

  it('clears the host when the status is invalidated', async () => {
    const store = createStore()
    await store.getState().refreshPreflightStatus()

    store.getState().invalidatePreflightStatus()
    expect(store.getState().preflightStatusHost).toBeNull()
  })
})
