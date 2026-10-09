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
import { useAppStore } from '@/store'
import {
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'
import { installHostModelCatalogSnapshotsSync } from './host-model-catalog-snapshots-sync'

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

  it('drops an agent’s answers when the host says the account has no list', () => {
    recordHostModelCatalogSnapshot(LOCAL, 'codex', 'wt-1', list(true))
    recordHostModelCatalogSnapshot(LOCAL, 'codex', 'wt-1', { origin: 'unknown' })
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', NEW_CHAT)).toBeUndefined()
  })
})

const SAVED_ONLY = 'agent-session.model-catalog.saved-only.v1'
const REGISTERED = ['claude', 'codex', 'grok', 'opencode', 'omp'].map((agent) => ({ agent }))

function registerAgents(hostId: string, runtimeId: string | null): void {
  mocks.agents.set(hostId, { runtimeId, agents: REGISTERED })
  mocks.agentListeners.forEach((listener) => listener())
}

/** The host saved lists for Grok, OpenCode and OMP only; nothing for Claude or Codex. */
function savedFor(agents: readonly string[]) {
  return async (_target: unknown, _method: string, params: { agent: string }) =>
    agents.includes(params.agent) ? list(false) : { origin: 'unknown' }
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

  it('loads every registered agent saved-only, picked or not; an agent with nothing saved stays unknown', async () => {
    mocks.capabilities = [SAVED_ONLY]
    mocks.call.mockImplementation(savedFor(['grok', 'opencode', 'omp']))
    stop = installHostModelCatalogSnapshotsSync()
    // Nothing is read until the host's agents are known; their arrival reads them.
    await Promise.resolve()
    expect(mocks.call).not.toHaveBeenCalled()
    registerAgents('local', null)
    await vi.waitFor(() =>
      expect(readHostModelCatalogSnapshot(LOCAL, 'omp', NEW_CHAT)).toEqual(list(false))
    )
    expect(mocks.call.mock.calls.map(([, method, params]) => [method, params])).toEqual(
      REGISTERED.map(({ agent }) => ['agentSession.modelCatalog', { agent, savedOnly: true }])
    )
    expect(readHostModelCatalogSnapshot(LOCAL, 'grok', NEW_CHAT)).toEqual(list(false))
    expect(readHostModelCatalogSnapshot(LOCAL, 'opencode', NEW_CHAT)).toEqual(list(false))
    expect(readHostModelCatalogSnapshot(LOCAL, 'claude', NEW_CHAT)).toBeUndefined()
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', NEW_CHAT)).toBeUndefined()
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
