// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  capabilities: new Array<string>(),
  agents: new Map<string, { runtimeId: string | null; agents: { agent: string }[] }>(),
  agentListeners: new Set<() => void>()
}))

vi.mock('./structured-agent-session-client', () => ({ callStructuredAgentSession: mocks.call }))
vi.mock('./local-structured-chats', () => ({ localStructuredChatsInUse: async () => true }))
vi.mock('./local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {},
  ensureLocalRuntimeCapabilities: async () => mocks.capabilities,
  readLocalRuntimeCapabilitiesOrUnknown: () => mocks.capabilities
}))
vi.mock('./host-structured-agents', () => ({
  readHostStructuredAgentsForRuntime: (hostId: string, runtimeId: string | null) => {
    const entry = mocks.agents.get(hostId)
    return entry && entry.runtimeId === runtimeId ? entry.agents : undefined
  },
  subscribeHostStructuredAgents: (listener: () => void) => {
    mocks.agentListeners.add(listener)
    return () => mocks.agentListeners.delete(listener)
  }
}))

import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { getDefaultSettings } from '../../../shared/constants'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { useAppStore } from '@/store'
import {
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'
import { installHostModelCatalogSnapshotsSync } from './host-model-catalog-snapshots-sync'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'

const LOCAL = { kind: 'local' } as const
const PAIRED = { kind: 'environment', environmentId: 'server-1' } as const
const NEW_CHAT = { newLaunch: true, worktree: 'wt-1', seedsModel: false }

function list(listingNamesConfiguredModel: boolean): AgentSessionModelCatalogResult {
  return {
    origin: 'probe',
    models: [{ id: 'm-1', label: 'M 1', isDefault: true, efforts: [] }],
    fetchedAt: 1,
    listingNamesConfiguredModel
  }
}

describe('host model catalog snapshots', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  it('serves a workspace’s own answer, and another’s only where the default cannot differ', () => {
    recordHostModelCatalogSnapshot(LOCAL, 'codex', null, list(true))
    // Another workspace's config may replace the default a chat naming no model would show.
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', NEW_CHAT)).toBeUndefined()
    const seeded = readHostModelCatalogSnapshot(LOCAL, 'codex', { ...NEW_CHAT, seedsModel: true })
    expect(seeded).toMatchObject({
      listingNamesConfiguredModel: false,
      models: [{ isDefault: false }]
    })
    // A reopened chat names no default anyway.
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', { ...NEW_CHAT, newLaunch: false })).toEqual(
      list(true)
    )
    recordHostModelCatalogSnapshot(LOCAL, 'codex', 'wt-1', list(true))
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', NEW_CHAT)).toEqual(list(true))
    // A list that names no default reads the same in every workspace.
    recordHostModelCatalogSnapshot(LOCAL, 'grok', null, list(false))
    expect(readHostModelCatalogSnapshot(LOCAL, 'grok', NEW_CHAT)).toEqual(list(false))
    expect(readHostModelCatalogSnapshot(PAIRED, 'codex', NEW_CHAT)).toBeUndefined()
  })

  it('serves a list the host says is a workspace’s own to that workspace only', () => {
    const ownList = { ...list(false), modelsDifferByWorkspace: true as const }
    recordHostModelCatalogSnapshot(LOCAL, 'opencode', 'wt-1', ownList)
    expect(readHostModelCatalogSnapshot(LOCAL, 'opencode', NEW_CHAT)).toEqual(ownList)
    expect(
      readHostModelCatalogSnapshot(LOCAL, 'opencode', { ...NEW_CHAT, worktree: 'wt-2' })
    ).toBeUndefined()
    expect(
      readHostModelCatalogSnapshot(LOCAL, 'opencode', {
        ...NEW_CHAT,
        newLaunch: false,
        worktree: 'wt-2'
      })
    ).toBeUndefined()
  })

  it('retires a workspace answer and its derived account fallback, retaining independent answers', () => {
    const worldwide = { ...list(true), defaultHoldsInEveryWorkspace: true as const }
    const scoped = { ...list(false), modelsDifferByWorkspace: true as const }
    const other = { ...NEW_CHAT, worktree: 'wt-2' }
    recordHostModelCatalogSnapshot(PAIRED, 'grok', 'wt-1', worldwide)
    recordHostModelCatalogSnapshot(LOCAL, 'omp', 'wt-1', scoped)
    for (const retired of [{ origin: 'unknown' } as const, { ...worldwide, models: [] }]) {
      recordHostModelCatalogSnapshot(LOCAL, 'grok', 'wt-2', scoped)
      recordHostModelCatalogSnapshot(LOCAL, 'grok', 'wt-1', worldwide)
      expect(readHostModelCatalogSnapshot(LOCAL, 'grok', NEW_CHAT)).toBe(worldwide)
      recordHostModelCatalogSnapshot(LOCAL, 'grok', 'wt-1', retired)
      expect(readHostModelCatalogSnapshot(LOCAL, 'grok', NEW_CHAT)).toBeUndefined()
      expect(readHostModelCatalogSnapshot(LOCAL, 'grok', other)).toBe(scoped)
      expect(readHostModelCatalogSnapshot(PAIRED, 'grok', NEW_CHAT)).toBe(worldwide)
      expect(readHostModelCatalogSnapshot(LOCAL, 'omp', NEW_CHAT)).toBe(scoped)
    }
    const newer = { ...worldwide, fetchedAt: 2 }
    recordHostModelCatalogSnapshot(LOCAL, 'grok', 'wt-1', worldwide)
    recordHostModelCatalogSnapshot(LOCAL, 'grok', 'wt-2', newer)
    recordHostModelCatalogSnapshot(LOCAL, 'grok', 'wt-1', { origin: 'unknown' })
    expect(readHostModelCatalogSnapshot(LOCAL, 'grok', NEW_CHAT)).toBe(newer)
    recordHostModelCatalogSnapshot(LOCAL, 'grok', null, worldwide)
    recordHostModelCatalogSnapshot(LOCAL, 'grok', 'wt-1', scoped)
    recordHostModelCatalogSnapshot(LOCAL, 'grok', 'wt-1', { origin: 'unknown' })
    expect(readHostModelCatalogSnapshot(LOCAL, 'grok', NEW_CHAT)).toBe(worldwide)
  })
})

const SAVED_ONLY = 'agent-session.model-catalog.saved-only.v1'
const REGISTERED = ['claude', 'codex', 'grok', 'opencode', 'omp'].map((agent) => ({ agent }))

function registerAgents(hostId: string, runtimeId: string | null): void {
  mocks.agents.set(hostId, { runtimeId, agents: REGISTERED })
  mocks.agentListeners.forEach((listener) => listener())
}

describe('host model catalog snapshots sync', () => {
  let stop: (() => void) | null = null
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.call.mockResolvedValue(list(false))
    mocks.capabilities = []
    mocks.agents.clear()
    mocks.agentListeners.clear()
    resetHostModelCatalogSnapshotsForTests()
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        nativeChatSessionOptions: { claude: { model: 'opus[1m]' }, codex: {} }
      },
      runtimeStatusByEnvironmentId: new Map()
    })
  })
  afterEach(() => stop?.())

  it('retires reconnect observers after catalog removals while preserving live hosts', async () => {
    const count = 10
    const previous = useAppStore.getState()
    useAppStore.setState({
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map(),
      removedRuntimeEnvironmentIds: new Set()
    })
    mocks.capabilities = [SAVED_ONLY]
    const environment = (id: string): PublicKnownRuntimeEnvironment => ({
      id,
      name: id,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [{ id: `ws-${id}`, kind: 'websocket', label: 'WebSocket', endpoint: 'ws://host' }],
      preferredEndpointId: `ws-${id}`
    })
    const setStatus = (id: string, epoch: number): void => {
      const response = createCompatibleRuntimeStatusResponse(`rt-${id}`)
      if (!response.ok) {
        throw new Error('Expected a compatible runtime status')
      }
      const statuses = new Map(useAppStore.getState().runtimeStatusByEnvironmentId)
      statuses.set(id, {
        status: { ...response.result, capabilities: [SAVED_ONLY] },
        checkedAt: epoch,
        hostContactEpoch: epoch,
        connectionGeneration: 1
      })
      useAppStore.setState({ runtimeStatusByEnvironmentId: statuses })
    }
    const survivor = environment('survivor')
    useAppStore.getState().setRuntimeEnvironments([survivor])
    setStatus(survivor.id, 1)
    mocks.agents.set('runtime:survivor', {
      runtimeId: 'rt-survivor',
      agents: [{ agent: 'codex' }]
    })
    const active = new Set<() => void>()
    let callbacks = 0
    const subscribe = useAppStore.subscribe
    const spy = vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
      const unsubscribe = subscribe((state, oldState) => {
        callbacks += 1
        listener(state, oldState)
      })
      const release = (): void => {
        active.delete(release)
        unsubscribe()
      }
      active.add(release)
      return release
    })
    try {
      stop = installHostModelCatalogSnapshotsSync()
      for (let index = 0; index < count; index += 1) {
        const retired = environment(`retired-${index}`)
        useAppStore.getState().setRuntimeEnvironments([survivor, retired])
        setStatus(retired.id, 1)
        if (index === 0) {
          useAppStore.getState().clearRuntimeEnvironmentStatus(retired.id)
          expect(active.size).toBe(3)
        }
        useAppStore.getState().setRuntimeEnvironments([survivor])
      }
      setStatus('retired-0', 3)
      expect(active.size).toBe(2)
      callbacks = 0
      useAppStore.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
      expect(callbacks).toBe(2)

      mocks.call.mockClear()
      useAppStore.getState().clearRuntimeEnvironmentStatus(survivor.id)
      expect(active.size).toBe(2)
      setStatus(survivor.id, 2)
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
      expect(mocks.call.mock.calls[0][0]).toEqual({
        kind: 'environment',
        environmentId: survivor.id
      })

      const readded = environment('retired-0')
      useAppStore.getState().setRuntimeEnvironments([survivor, readded])
      setStatus(readded.id, 1)
      expect(active.size).toBe(3)
      mocks.agents.set('runtime:retired-0', {
        runtimeId: 'rt-retired-0',
        agents: [{ agent: 'codex' }]
      })
      mocks.call.mockClear()
      setStatus(readded.id, 2)
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
      expect(mocks.call.mock.calls[0][0]).toEqual({
        kind: 'environment',
        environmentId: readded.id
      })

      stop()
      stop = null
      expect(active.size).toBe(0)
      callbacks = 0
      useAppStore.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
      expect(callbacks).toBe(0)
    } finally {
      stop?.()
      stop = null
      spy.mockRestore()
      useAppStore.setState({
        runtimeEnvironments: previous.runtimeEnvironments,
        runtimeStatusByEnvironmentId: previous.runtimeStatusByEnvironmentId,
        removedRuntimeEnvironmentIds: previous.removedRuntimeEnvironmentIds
      })
    }
  })

  it('a host removed and re-added under the same id does not keep its old lists', () => {
    const previous = useAppStore.getState()
    const environment: PublicKnownRuntimeEnvironment = {
      id: PAIRED.environmentId,
      name: 'server',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [{ id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://host' }],
      preferredEndpointId: 'ws'
    }
    const publishStatus = (): void => {
      const response = createCompatibleRuntimeStatusResponse('rt-1')
      if (!response.ok) {
        throw new Error('Expected a compatible runtime status')
      }
      useAppStore.getState().setRuntimeEnvironmentStatus(PAIRED.environmentId, {
        status: response.result,
        checkedAt: 1
      })
    }
    const reopened = { ...NEW_CHAT, newLaunch: false }
    try {
      useAppStore.setState({ runtimeEnvironments: [], removedRuntimeEnvironmentIds: new Set() })
      useAppStore.getState().setRuntimeEnvironments([environment])
      publishStatus()
      stop = installHostModelCatalogSnapshotsSync()
      recordHostModelCatalogSnapshot(PAIRED, 'codex', null, list(false))
      expect(readHostModelCatalogSnapshot(PAIRED, 'codex', reopened)).toEqual(list(false))
      useAppStore.getState().setRuntimeEnvironments([])
      useAppStore.getState().setRuntimeEnvironments([environment])
      publishStatus()
      expect(readHostModelCatalogSnapshot(PAIRED, 'codex', reopened)).toBeUndefined()
    } finally {
      stop?.()
      stop = null
      useAppStore.setState({
        runtimeEnvironments: previous.runtimeEnvironments,
        runtimeStatusByEnvironmentId: previous.runtimeStatusByEnvironmentId,
        removedRuntimeEnvironmentIds: previous.removedRuntimeEnvironmentIds
      })
    }
  })

  it('an older runtime: loads only agents with a saved pick, and forgets them on an account change', async () => {
    stop = installHostModelCatalogSnapshotsSync()
    await vi.waitFor(() =>
      expect(readHostModelCatalogSnapshot(LOCAL, 'claude', NEW_CHAT)).toEqual(list(false))
    )
    // Its read lists when nothing is saved: no saved-only read, and no agent the user never picked.
    expect(mocks.call.mock.calls).toEqual([
      [LOCAL, 'agentSession.modelCatalog', { agent: 'claude' }]
    ])
    registerAgents('local', null)
    const settings = useAppStore.getState().settings!
    useAppStore.setState({ settings: { ...settings, activeClaudeManagedAccountId: 'other' } })
    expect(readHostModelCatalogSnapshot(LOCAL, 'claude', NEW_CHAT)).toBeUndefined()
    await Promise.resolve()
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('reads again for the new account after an account change, dropping an answer sent before it', async () => {
    mocks.capabilities = [SAVED_ONLY]
    registerAgents('local', null)
    let answerOld!: (value: unknown) => void
    mocks.call.mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)))
    mocks.call.mockResolvedValue({ origin: 'unknown' })
    stop = installHostModelCatalogSnapshotsSync()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(REGISTERED.length))
    const settings = useAppStore.getState().settings!
    mocks.call.mockReset()
    mocks.call.mockResolvedValue(list(true))
    useAppStore.setState({ settings: { ...settings, activeClaudeManagedAccountId: 'other' } })
    const reopened = { ...NEW_CHAT, newLaunch: false }
    await vi.waitFor(() =>
      expect(readHostModelCatalogSnapshot(LOCAL, 'claude', reopened)).toEqual(list(true))
    )
    expect(mocks.call.mock.calls.every(([, , params]) => params.savedOnly === true)).toBe(true)
    // The old account's answer lands late: it is not the account a new chat pins now.
    answerOld(list(false))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readHostModelCatalogSnapshot(LOCAL, 'claude', reopened)).toEqual(list(true))
  })

  it('a paired host: saved-only at connect when it advertises it, nothing from an older one', async () => {
    const status = (capabilities: string[]) =>
      new Map([['server-1', { status: { runtimeId: 'rt-1', capabilities } }]])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sync reads only status.runtimeId and status.capabilities.
    useAppStore.setState({ runtimeStatusByEnvironmentId: status([]) as never })
    stop = installHostModelCatalogSnapshotsSync()
    registerAgents('runtime:server-1', 'rt-1')
    await Promise.resolve()
    expect(mocks.call.mock.calls.filter(([target]) => target.kind === 'environment')).toEqual([])
    stop()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    useAppStore.setState({ runtimeStatusByEnvironmentId: status([SAVED_ONLY]) as never })
    stop = installHostModelCatalogSnapshotsSync()
    registerAgents('runtime:server-1', 'rt-1')
    await vi.waitFor(() =>
      expect(readHostModelCatalogSnapshot(PAIRED, 'grok', NEW_CHAT)).toEqual(list(false))
    )
    expect(
      mocks.call.mock.calls
        .filter(([target]) => target.kind === 'environment')
        .every(([, , params]) => params.savedOnly === true)
    ).toBe(true)
  })
})
