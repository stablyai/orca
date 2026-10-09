import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinTheme } from '@/lib/terminal-theme'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RepoTerminalViewAttributesPayload } from '../../../../shared/terminal-view-attributes'
import type { RepoTerminalViewAttributesByHost } from '../../../../shared/repo-terminal-view-attributes-by-host'
import {
  _resetRepoTerminalViewAttributesPublisherForTest,
  composeRepoTerminalViewAttributesByHost,
  installRepoTerminalViewAttributesPublisher,
  publishRepoTerminalViewAttributes,
  type RepoTerminalViewAttributesSource
} from './repo-terminal-view-attributes-publisher'
import { composeActiveTerminalTheme } from './terminal-appearance'
import { composeTerminalViewAttributes } from './terminal-view-attributes-publisher'
import { resetSystemPrefersDarkSubscriptionForTests } from './use-system-prefers-dark'
import type { AppState } from '../../store/types'
import {
  awaitLatestLocalRepoCatalogFetch,
  startLocalRepoCatalogFetch
} from '../../store/repos/repo-catalog-fencing'

type TestRepo = RepoTerminalViewAttributesSource['repos'][number]
type TestStoreState = {
  settings: GlobalSettings | null
  repos: TestRepo[]
  reposFetchGeneration: number
}

const storeMock = vi.hoisted(() => {
  type State = {
    settings: unknown
    repos: unknown[]
    reposFetchGeneration: number
    awaitLocalRepoCatalogSettlement: () => Promise<void>
  }
  let settlement: Promise<void> = Promise.resolve()
  const initialState = (): State => ({
    settings: null,
    repos: [],
    reposFetchGeneration: 0,
    awaitLocalRepoCatalogSettlement: () => settlement
  })
  let state = initialState()
  const listeners = new Set<(next: State, prev: State) => void>()
  return {
    getState: () => state,
    setState: (patch: Partial<State>) => {
      const prev = state
      state = { ...state, ...patch }
      for (const listener of listeners) {
        listener(state, prev)
      }
    },
    subscribe: (listener: (next: State, prev: State) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setSettlement: (next: Promise<void>) => {
      settlement = next
    },
    reset: () => {
      settlement = Promise.resolve()
      state = initialState()
      listeners.clear()
    },
    listenerCount: () => listeners.size
  }
})

vi.mock('@/store', () => ({ useAppStore: storeMock }))

function setStore(patch: Partial<TestStoreState>): void {
  storeMock.setState(patch)
}

function darkSettings(): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), theme: 'dark' }
}

const DRACULA_REPO: TestRepo = { id: 'repo-a', terminalTheme: { dark: 'Dracula' } }
const PLAIN_REPO_A: TestRepo = { id: 'repo-a' }

function byHostFor(
  input: RepoTerminalViewAttributesSource,
  systemPrefersDark = true
): RepoTerminalViewAttributesByHost {
  return composeRepoTerminalViewAttributesByHost(input, systemPrefersDark)
}

describe('composeRepoTerminalViewAttributesByHost', () => {
  it('returns an empty map without settings', () => {
    expect(byHostFor({ settings: null, repos: [DRACULA_REPO] })).toEqual({})
  })

  it('keys repos with a resolvable theme by execution host; paired-runtime rows are excluded', () => {
    const byHost = byHostFor({
      settings: darkSettings(),
      repos: [
        DRACULA_REPO,
        { id: 'repo-plain' },
        { id: 'repo-ssh-legacy', connectionId: 't', terminalTheme: { dark: 'Dracula' } },
        { id: 'repo-ssh', executionHostId: 'ssh:t', terminalTheme: { dark: 'Dracula' } },
        { id: 'repo-a', executionHostId: 'ssh:u', terminalTheme: { dark: 'Nord' } },
        { id: 'repo-runtime', executionHostId: 'runtime:e', terminalTheme: { dark: 'Dracula' } },
        { id: 'repo-missing', terminalTheme: { dark: 'custom:ghostty:deleted' } }
      ]
    })
    expect(Object.keys(byHost)).toEqual(['local', 'ssh:t', 'ssh:u'])
    expect(Object.keys(byHost.local)).toEqual(['repo-a'])
    expect(Object.keys(byHost['ssh:t'])).toEqual(['repo-ssh-legacy', 'repo-ssh'])
    // The same repo id on two hosts: each host's own pick.
    expect(byHost['ssh:u']['repo-a'].background).toEqual([0x2e, 0x34, 0x40])
    expect(byHost.local['repo-a'].background).toEqual([0x28, 0x2a, 0x36])
  })

  it('skips a malformed stored theme instead of throwing for the whole map', () => {
    const malformed: TestRepo = { id: 'repo-malformed' }
    Object.assign(malformed, { terminalTheme: JSON.parse('{"dark":{"name":"Dracula"}}') })
    const byHost = byHostFor({ settings: darkSettings(), repos: [malformed, DRACULA_REPO] })
    expect(Object.keys(byHost.local)).toEqual(['repo-a'])
  })

  it('matches the attributes a visible pane with the repo theme would publish', () => {
    const settings = darkSettings()
    const byRepoId = byHostFor({ settings, repos: [DRACULA_REPO] }).local
    const paneSettings = { ...settings, terminalThemeDark: 'Dracula' }
    const expected = composeTerminalViewAttributes(
      composeActiveTerminalTheme(getBuiltinTheme('Dracula'), paneSettings),
      'dark',
      paneSettings
    )
    expect(byRepoId['repo-a']).toEqual(expected)
    expect(byRepoId['repo-a']?.background).toEqual([0x28, 0x2a, 0x36])
    expect(byRepoId['repo-a']?.colorSchemeMode).toBe('dark')
  })

  it('selects the light variant when the system prefers light under theme system', () => {
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      theme: 'system'
    }
    const byRepoId = byHostFor(
      {
        settings,
        repos: [{ id: 'repo-a', terminalTheme: { dark: 'Dracula', light: 'Solarized Light' } }]
      },
      false
    ).local
    expect(byRepoId['repo-a']?.background).toEqual([0xfd, 0xf6, 0xe3])
    expect(byRepoId['repo-a']?.colorSchemeMode).toBe('light')
  })

  it('keeps global color overrides on top of a repo pick, as the pane does', () => {
    const settings: GlobalSettings = {
      ...darkSettings(),
      terminalColorOverrides: { background: '#000000' }
    }
    expect(byHostFor({ settings, repos: [DRACULA_REPO] }).local['repo-a']?.background).toEqual([
      0, 0, 0
    ])
  })
})

describe('publishRepoTerminalViewAttributes', () => {
  beforeEach(() => _resetRepoTerminalViewAttributesPublisherForTest())

  function mapFor(repos: TestRepo[]): RepoTerminalViewAttributesByHost {
    return byHostFor({ settings: darkSettings(), repos })
  }

  it('dedupes identical maps and re-sends on change', () => {
    const send = vi.fn<(payload: RepoTerminalViewAttributesPayload) => 'sent'>(() => 'sent')
    expect(publishRepoTerminalViewAttributes(mapFor([DRACULA_REPO]), send)).toBe('published')
    expect(publishRepoTerminalViewAttributes(mapFor([DRACULA_REPO]), send)).toBe('deduped')
    expect(
      publishRepoTerminalViewAttributes(
        mapFor([{ ...PLAIN_REPO_A, terminalTheme: { dark: 'Nord' } }]),
        send
      )
    ).toBe('published')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not record a snapshot the bridge failed to send', () => {
    const map = mapFor([DRACULA_REPO])
    expect(publishRepoTerminalViewAttributes(map, () => 'no-bridge')).toBe('no-bridge')
    const send = vi.fn<(payload: RepoTerminalViewAttributesPayload) => 'sent'>(() => 'sent')
    expect(publishRepoTerminalViewAttributes(map, send)).toBe('published')
    expect(send).toHaveBeenCalledWith({ byHostId: map })
  })
})

describe('installRepoTerminalViewAttributesPublisher', () => {
  let publishMock: ReturnType<typeof vi.fn<(payload: RepoTerminalViewAttributesPayload) => void>>

  beforeEach(() => {
    _resetRepoTerminalViewAttributesPublisherForTest()
    resetSystemPrefersDarkSubscriptionForTests()
    storeMock.reset()
    publishMock = vi.fn<(payload: RepoTerminalViewAttributesPayload) => void>()
    vi.stubGlobal('window', {
      api: { pty: { publishRepoTerminalViewAttributes: publishMock } }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetSystemPrefersDarkSubscriptionForTests()
    _resetRepoTerminalViewAttributesPublisherForTest()
  })

  async function installHydrated(): Promise<() => void> {
    const dispose = installRepoTerminalViewAttributesPublisher()
    setStore({ reposFetchGeneration: 1 })
    await Promise.resolve()
    return dispose
  }

  it('publishes once the local catalog settles and again when repos change', async () => {
    setStore({ settings: darkSettings(), repos: [DRACULA_REPO] })
    const dispose = await installHydrated()
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(Object.keys(publishMock.mock.calls[0]?.[0]?.byHostId?.local ?? {})).toEqual(['repo-a'])

    // New reference, same content: deduped.
    setStore({ repos: [{ ...DRACULA_REPO }] })
    expect(publishMock).toHaveBeenCalledTimes(1)

    setStore({
      repos: [DRACULA_REPO, { id: 'repo-b', terminalTheme: { dark: 'Nord' } }]
    })
    expect(publishMock).toHaveBeenCalledTimes(2)
    expect(Object.keys(publishMock.mock.calls[1]?.[0]?.byHostId?.local ?? {})).toEqual([
      'repo-a',
      'repo-b'
    ])

    dispose()
    expect(storeMock.listenerCount()).toBe(0)
    setStore({ repos: [] })
    expect(publishMock).toHaveBeenCalledTimes(2)
  })

  it('sends nothing before the local repo catalog settles (fresh renderer reload)', async () => {
    let settle: () => void = () => undefined
    storeMock.setSettlement(
      new Promise<void>((resolve) => {
        settle = resolve
      })
    )
    const dispose = installRepoTerminalViewAttributesPublisher()
    setStore({ settings: darkSettings() })
    setStore({ reposFetchGeneration: 1 })
    await Promise.resolve()
    expect(publishMock).not.toHaveBeenCalled()

    setStore({ repos: [DRACULA_REPO] })
    settle()
    await Promise.resolve()
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(Object.keys(publishMock.mock.calls[0]?.[0]?.byHostId?.local ?? {})).toEqual(['repo-a'])
    dispose()
  })

  it('retries after a failed catalog fetch instead of publishing its empty repos', async () => {
    storeMock.setSettlement(Promise.reject(new Error('ipc down')))
    setStore({ settings: darkSettings() })
    const dispose = installRepoTerminalViewAttributesPublisher()
    setStore({ reposFetchGeneration: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(publishMock).not.toHaveBeenCalled()

    storeMock.setSettlement(Promise.resolve())
    setStore({ repos: [DRACULA_REPO], reposFetchGeneration: 2 })
    await Promise.resolve()
    expect(publishMock).toHaveBeenCalledTimes(1)
    dispose()
  })

  describe('with the real local-catalog fencing', () => {
    let fencingKey: () => AppState

    async function flushMicrotasks(): Promise<void> {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve()
      }
    }

    beforeEach(() => {
      // A fresh getter per test: fencing keys its registrations by the store getter.
      const key = (): AppState => {
        throw new Error('fencing only uses the getter as a key')
      }
      fencingKey = key
      storeMock.setState({
        awaitLocalRepoCatalogSettlement: () => awaitLatestLocalRepoCatalogFetch(key)
      })
    })

    it('does not arm on a runtime-only catalog fetch before the local catalog registers', async () => {
      const dispose = installRepoTerminalViewAttributesPublisher()
      setStore({ settings: darkSettings() })
      // fetchRuntimeEnvironmentRepos bumps the shared generation without registering a local fetch.
      setStore({ reposFetchGeneration: 1 })
      await flushMicrotasks()
      expect(publishMock).not.toHaveBeenCalled()

      const settle = startLocalRepoCatalogFetch(fencingKey)
      setStore({ reposFetchGeneration: 2 })
      await flushMicrotasks()
      expect(publishMock).not.toHaveBeenCalled()

      setStore({ repos: [DRACULA_REPO] })
      settle({ status: 'fulfilled' })
      await flushMicrotasks()
      expect(publishMock).toHaveBeenCalledTimes(1)
      expect(Object.keys(publishMock.mock.calls[0]?.[0]?.byHostId?.local ?? {})).toEqual(['repo-a'])
      dispose()
    })

    it('re-awaits a local fetch that starts while a failed one is being reported', async () => {
      const settleFailed = startLocalRepoCatalogFetch(fencingKey)
      setStore({ settings: darkSettings(), reposFetchGeneration: 1 })
      const dispose = installRepoTerminalViewAttributesPublisher()
      await flushMicrotasks()

      let settleRetry: ReturnType<typeof startLocalRepoCatalogFetch> = () => undefined
      settleFailed({ status: 'rejected', reason: new Error('ipc down') })
      // Lands after the fencing rejects but before the publisher handles the rejection.
      queueMicrotask(() => {
        settleRetry = startLocalRepoCatalogFetch(fencingKey)
        setStore({ reposFetchGeneration: 2, repos: [DRACULA_REPO] })
      })
      await flushMicrotasks()
      expect(publishMock).not.toHaveBeenCalled()

      settleRetry({ status: 'fulfilled' })
      await flushMicrotasks()
      expect(publishMock).toHaveBeenCalledTimes(1)
      dispose()
    })
  })

  it('never publishes an empty map while settings are null', async () => {
    setStore({ repos: [DRACULA_REPO] })
    const dispose = await installHydrated()
    expect(publishMock).not.toHaveBeenCalled()

    setStore({ settings: darkSettings() })
    expect(publishMock).toHaveBeenCalledTimes(1)

    // Runtime focus switch nulls settings: main must keep the repo map.
    setStore({ settings: null })
    expect(publishMock).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('still publishes an empty map once the last themed repo is cleared', async () => {
    setStore({ settings: darkSettings(), repos: [DRACULA_REPO] })
    const dispose = await installHydrated()
    setStore({ repos: [PLAIN_REPO_A] })
    expect(publishMock).toHaveBeenCalledTimes(2)
    expect(publishMock.mock.calls[1]?.[0]).toEqual({ byHostId: {} })
    dispose()
  })
})
