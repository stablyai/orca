// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  agentListeners: new Set<() => void>(),
  agentsKnown: false
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/local-structured-chats', () => ({ localStructuredChatsInUse: async () => true }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {},
  ensureLocalRuntimeCapabilities: async () => ['agent-session.model-catalog.saved-only.v1'],
  readLocalRuntimeCapabilitiesOrUnknown: () => ['agent-session.model-catalog.saved-only.v1']
}))
vi.mock('@/runtime/host-structured-agents', () => ({
  readHostStructuredAgentsForRuntime: (hostId: string) =>
    mocks.agentsKnown && hostId === 'local' ? REGISTERED : undefined,
  subscribeHostStructuredAgents: (listener: () => void) => {
    mocks.agentListeners.add(listener)
    return () => mocks.agentListeners.delete(listener)
  }
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import { installHostModelCatalogSnapshotsSync } from '@/runtime/host-model-catalog-snapshots-sync'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

// Grok, OpenCode and OMP chats were used, but none has a saved model pick: the user's report was
// that these painted the "Model" placeholder, then the host's pills.
const REGISTERED = ['claude', 'codex', 'grok', 'opencode', 'omp'].map((agent) => ({ agent }))
const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' }
]

function saved(
  ids: string[],
  names: 'default' | 'nothing'
): Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }> {
  return {
    origin: 'live-session',
    models: ids.map((id, index) => ({
      id,
      label: `${id} (saved)`,
      isDefault: names === 'default' && index === 0,
      defaultEffort: 'high',
      efforts: EFFORTS
    })),
    fetchedAt: 1_000,
    listingNamesConfiguredModel: names === 'default',
    ...(names === 'default' ? { defaultHoldsInEveryWorkspace: true as const } : {})
  }
}

const SAVED: Readonly<Record<string, AgentSessionModelCatalogResult>> = {
  // Grok's listing names the default, and no project config can replace it.
  grok: saved(['grok-4.6', 'grok-4.7'], 'default'),
  // OpenCode and OMP lists name no default: a chat with no pick names its model when it reports.
  opencode: saved(['github-copilot/claude-fable-5', 'github-copilot/gpt-6'], 'nothing'),
  omp: saved(['openai-codex/gpt-5.5', 'openai-codex/gpt-5.6-sol'], 'nothing')
}

type Pill = { model: string | null; label: string | null; effort: string | null; usable: boolean }

function pill(snapshot: readonly SessionOptionDescriptor[]): Pill {
  const model = snapshot.find((entry) => entry.id === 'model')
  const effort = snapshot.find((entry) => entry.id === 'effort')
  const current = model?.kind.type === 'select' ? (model.kind.currentValue ?? null) : null
  const choice =
    model?.kind.type === 'select'
      ? model.kind.choices.find((entry) => entry.value === current)
      : undefined
  return {
    model: current,
    label: choice?.label ?? null,
    effort: effort?.kind.type === 'select' ? (effort.kind.currentValue ?? null) : null,
    usable: Boolean(model?.settable)
  }
}

function renderNewChat(agent: string) {
  const frames: Pill[] = []
  const view = renderHook(() => {
    const options = useStructuredAgentSessionOptions({
      agent,
      sessionId: `session-${agent}`,
      target: { kind: 'local' },
      transportEnabled: false,
      isVisible: true,
      providerVisible: false,
      fence: null,
      turnId: null,
      unloadedTurnRevisions: undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no pick is made, so mutate is never called.
      mutate: vi.fn() as unknown as StructuredAgentSessionMutate,
      launch: { kind: 'new', heldOptions: {}, worktree: 'id:wt-1' }
    })
    frames.push(pill(options.optionSnapshot))
    return options
  })
  return { frames, ...view }
}

describe('a new chat of an agent with no saved pick', () => {
  let stop: (() => void) | null = null
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.agentListeners.clear()
    mocks.agentsKnown = false
    resetHostModelCatalogSnapshotsForTests()
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        nativeChatSessionOptions: { claude: { model: 'opus[1m]' } }
      },
      runtimeStatusByEnvironmentId: new Map()
    })
    // Each read answers what the host saved: the preload's and the pane's own alike.
    mocks.call.mockImplementation(
      async (_target: unknown, method: string, params: { agent: string }) =>
        method === 'agentSession.modelCatalog'
          ? (SAVED[params.agent] ?? { origin: 'unknown' })
          : new Promise(() => {})
    )
  })
  afterEach(() => stop?.())

  it.each([
    ['grok', { model: 'grok-4.6', label: 'grok-4.6 (saved)', effort: 'high', usable: true }],
    ['opencode', { model: null, label: null, effort: null, usable: true }],
    ['omp', { model: null, label: null, effort: null, usable: true }]
  ] as const)(
    '%s: the host’s saved list, preloaded at startup, paints the final pills on the first frame',
    async (agent, final) => {
      stop = installHostModelCatalogSnapshotsSync()
      mocks.agentsKnown = true
      mocks.agentListeners.forEach((listener) => listener())
      await waitFor(() =>
        expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.modelCatalog', {
          agent: 'omp',
          savedOnly: true
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      const reads = mocks.call.mock.calls.length
      const { frames, unmount } = renderNewChat(agent)
      expect(frames[0]).toEqual(final)
      // The pane's own read lands the same answer: no frame ever showed anything else.
      await waitFor(() => expect(mocks.call.mock.calls.length).toBeGreaterThan(reads))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(frames.every((frame) => JSON.stringify(frame) === JSON.stringify(final))).toBe(true)
      unmount()
    }
  )
})
