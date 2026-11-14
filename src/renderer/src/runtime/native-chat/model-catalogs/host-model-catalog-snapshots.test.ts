// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  capabilities: new Array<string>(),
  agents: new Map<string, { runtimeId: string | null; agents: { agent: string }[] }>(),
  agentListeners: new Set<() => void>()
}))

vi.mock('../requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('../../hosts/capabilities/local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {},
  ensureLocalRuntimeCapabilities: async () => mocks.capabilities,
  readLocalRuntimeCapabilitiesOrUnknown: () => mocks.capabilities
}))
vi.mock('../agent-catalogs/host-structured-agents', () => ({
  readHostStructuredAgentsForRuntime: (hostId: string, runtimeId: string | null) => {
    const entry = mocks.agents.get(hostId)
    return entry && entry.runtimeId === runtimeId ? entry.agents : undefined
  },
  subscribeHostStructuredAgents: (listener: () => void) => {
    mocks.agentListeners.add(listener)
    return () => mocks.agentListeners.delete(listener)
  }
}))

import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import { getDefaultSettings } from '../../../../../shared/constants'
import { useAppStore } from '@/store/index'
import {
  readHostModelCatalogSnapshot,
  loadHostModelCatalogSnapshot,
  forgetHostModelCatalogSnapshots,
  preloadHostModelCatalogSnapshots,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'
import { installHostModelCatalogSnapshotsSync } from './host-model-catalog-snapshots-sync'

const LOCAL = { kind: 'local' } as const
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

  it('withholds a direct reply invalidated by an account or host change', async () => {
    let finish: ((value: AgentSessionModelCatalogResult) => void) | undefined
    mocks.call.mockImplementationOnce(
      () =>
        new Promise<AgentSessionModelCatalogResult>((resolve) => {
          finish = resolve
        })
    )
    const pending = loadHostModelCatalogSnapshot(LOCAL, 'codex')
    forgetHostModelCatalogSnapshots(LOCAL)
    finish?.(list(false))
    expect(await pending).toBeUndefined()
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', NEW_CHAT)).toBeUndefined()
  })

  it('awaits a listing only after the host reports it in progress, and records the settled answer', async () => {
    mocks.call
      .mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true })
      .mockResolvedValueOnce(list(false))
    await preloadHostModelCatalogSnapshots(LOCAL, ['codex'], { awaitListing: true })
    expect(mocks.call.mock.calls).toEqual([
      [LOCAL, 'agentSession.modelCatalog', { agent: 'codex' }],
      [LOCAL, 'agentSession.modelCatalog', { agent: 'codex', waitForListing: true }]
    ])
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', { ...NEW_CHAT, newLaunch: false })).toEqual(
      list(false)
    )
  })

  it('does not send the listing wait field to an older host or with a saved-only read', async () => {
    mocks.call.mockResolvedValue(list(false))
    await preloadHostModelCatalogSnapshots(LOCAL, ['codex'], { awaitListing: true })
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(LOCAL, 'agentSession.modelCatalog', {
      agent: 'codex'
    })
    mocks.call.mockClear()
    mocks.call.mockResolvedValue({ origin: 'unknown', listingInProgress: true })
    await preloadHostModelCatalogSnapshots(LOCAL, ['codex'], {
      savedOnly: true,
      awaitListing: true
    })
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(LOCAL, 'agentSession.modelCatalog', {
      agent: 'codex',
      savedOnly: true
    })
  })

  it("keeps a chat's answer that lands while an older preload is out", async () => {
    let answer: (catalog: AgentSessionModelCatalogResult) => void = () => {}
    mocks.call.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const preload = preloadHostModelCatalogSnapshots(LOCAL, ['claude'], { savedOnly: true })
    const chat = list(true)
    recordHostModelCatalogSnapshot(LOCAL, 'claude', 'wt-1', chat)
    answer(list(false))
    await preload
    expect(readHostModelCatalogSnapshot(LOCAL, 'claude', NEW_CHAT)).toBe(chat)
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
        agentDefaultSurface: 'chat',
        nativeChatSessionOptions: { claude: { model: 'opus[1m]' }, codex: {} }
      },
      runtimeStatusByEnvironmentId: new Map()
    })
  })
  afterEach(() => stop?.())

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
})
