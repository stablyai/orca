// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentModelCatalogStore,
  AGENT_MODEL_CATALOG_CURRENT_MS
} from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogService } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentModelCatalogFingerprint } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CLAUDE_STRUCTURED_AGENT } from '../../src/main/claude/claude-structured-agent-definition'
import type { AgentSessionModelOption } from '../../src/shared/agent-session-wire'
import type { StructuredAgentSessionMutate } from '../../src/renderer/src/components/native-chat/use-structured-agent-session-mutate'

const mocks = vi.hoisted(() => ({ call: vi.fn(), hold: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/components/native-chat/native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: mocks.hold,
  getStructuredAgentSessionLaunchSelection: () => null
}))
import { useStructuredAgentSessionOptions } from '../../src/renderer/src/components/native-chat/use-structured-agent-session-options'

const LOW = { value: 'low', label: 'Low' }
const HIGH = { value: 'high', label: 'High' }
const XHIGH = { value: 'xhigh', label: 'Extra high' }
const SONNET = { id: 'sonnet', label: 'Sonnet', isDefault: true, efforts: [LOW, HIGH] }
const OPUS = { id: 'opus', label: 'Opus', isDefault: false, efforts: [LOW, HIGH, XHIGH] }
const SEED = { model: 'opus', effort: 'high' }

let nextChat = 0

/** A new chat whose saved selection is Opus/High, before the host has a record for it, over a
 *  saved Sonnet-only list a minute old. */
function startingChat(input: {
  host: 'local' | 'paired'
  /** What the host's listing answers when it re-lists; absent, it fails. */
  relists?: AgentSessionModelOption[]
  /** Answers as a host that predates verification does. */
  olderHost?: boolean
  /** A floating chat in a workspace whose own config may pick another model. */
  floating?: boolean
}) {
  mocks.call.mockReset()
  mocks.hold.mockReset()
  const home = { variable: 'CLAUDE_CONFIG_DIR', path: `/accounts/starting-${++nextChat}` }
  const fingerprint = agentModelCatalogFingerprint({
    agent: 'claude',
    accountHome: home,
    wslDistro: null
  })
  let now = 1_000
  const store = new AgentModelCatalogStore({ now: () => now })
  store.recordSuccess(fingerprint, 'claude', {
    models: [SONNET],
    origin: 'probe',
    fastModeTierByModel: new Map()
  })
  now += AGENT_MODEL_CATALOG_CURRENT_MS
  const relists = input.relists
  const probe = vi.fn(async () => {
    if (!relists) {
      throw new Error('temporarily unavailable')
    }
    return { models: relists, origin: 'probe' as const, fastModeTierByModel: new Map() }
  })
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => undefined,
    drivesRecord: () => true,
    agents: { definition: () => CLAUDE_STRUCTURED_AGENT },
    probes: { claude: probe },
    resolveAccountHome: async () => home,
    workspaceMayOverrideDefaultModel: async () => true
  })
  mocks.call.mockImplementation(
    async (_target: unknown, method: string, params: Parameters<typeof service.read>[0]) => {
      if (method !== 'agentSession.modelCatalog') {
        return new Promise(() => {})
      }
      // As the host's handler does before a record exists: the decision is about the saved seed.
      const answer = await service.read({
        ...params,
        requiredModel: SEED.model,
        ...(input.floating ? { workspacePath: '/workspaces/floating' } : {})
      })
      if (!input.olderHost) {
        return answer
      }
      const { unlistedModelReplacement: _unknownToOlderHosts, ...older } = answer
      return older
    }
  )
  mocks.hold.mockResolvedValue({ kind: 'held' })
  const mutate: StructuredAgentSessionMutate = vi.fn(async () => null)
  const sessionId = `starting-${nextChat}`
  const target =
    input.host === 'local'
      ? { kind: 'local' as const }
      : { kind: 'environment' as const, environmentId: 'server-1' }
  const launch = { kind: 'new' as const, seedOptions: SEED, heldOptions: {} }
  const hook = renderHook(() =>
    useStructuredAgentSessionOptions({
      agent: 'claude',
      sessionId,
      target,
      transportEnabled: false,
      isVisible: true,
      providerVisible: false,
      providerStarting: true,
      fence: null,
      turnId: null,
      unloadedTurnRevisions: undefined,
      mutate,
      launch
    })
  )
  const row = (id: string) => hook.result.current.optionSnapshot.find((entry) => entry.id === id)
  const catalogReads = () =>
    mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog').length
  return { hook, row, probe, sessionId, mutate, catalogReads }
}

describe('Claude picker before the provider starts', () => {
  it.each(['local', 'paired'] as const)(
    'keeps the selection on %s when the one re-listing still offers it, with its real efforts',
    async (host) => {
      const chat = startingChat({ host, relists: [SONNET, OPUS] })
      try {
        await waitFor(() =>
          expect(chat.row('model')?.kind).toMatchObject({
            currentValue: 'opus',
            choices: expect.arrayContaining([{ value: 'opus', label: 'Opus' }])
          })
        )
        expect(chat.row('effort')?.kind).toEqual({
          type: 'select',
          currentValue: 'high',
          choices: OPUS.efforts
        })
        expect(chat.probe).toHaveBeenCalledOnce()
        let accepted = false
        await act(async () => {
          accepted = await chat.hook.result.current.setStructuredOption('effort', 'xhigh')
        })
        expect(accepted).toBe(true)
        expect(mocks.hold).toHaveBeenCalledExactlyOnceWith(chat.sessionId, 'effort', 'xhigh')
        expect(chat.mutate).not.toHaveBeenCalled()
      } finally {
        chat.hook.unmount()
      }
    }
  )

  it.each(['local', 'paired'] as const)(
    'shows the default as selected on %s once the re-listing confirms the model is gone',
    async (host) => {
      const chat = startingChat({ host, relists: [SONNET] })
      try {
        await waitFor(() =>
          expect(chat.row('model')).toMatchObject({
            valueSource: 'default',
            kind: { currentValue: 'sonnet', choices: [{ value: 'sonnet', label: 'Sonnet' }] }
          })
        )
        // The effort carries over where the default lists it, as the host's start applies it.
        expect(chat.row('effort')?.kind).toEqual({
          type: 'select',
          currentValue: 'high',
          choices: SONNET.efforts
        })
        expect(chat.probe).toHaveBeenCalledOnce()
        // One read answered the re-listing in progress, one waited for it; nothing re-reads.
        expect(chat.catalogReads()).toBe(2)
      } finally {
        chat.hook.unmount()
      }
    }
  )

  it.each(['local', 'paired'] as const)(
    'replaces nothing on %s and invents no efforts while the list cannot be verified',
    async (host) => {
      const chat = startingChat({ host })
      try {
        await waitFor(() => expect(chat.probe).toHaveBeenCalledOnce())
        await waitFor(() => expect(chat.catalogReads()).toBe(2))
        // A saved pick the list doesn't name shows the quiet placeholder, never the default.
        expect(chat.row('model')?.kind).not.toHaveProperty('currentValue')
        expect(chat.row('effort')).toBeUndefined()
        let accepted = true
        await act(async () => {
          accepted = await chat.hook.result.current.setStructuredOption('effort', 'xhigh')
        })
        expect(accepted).toBe(false)
        expect(mocks.hold).not.toHaveBeenCalled()
        expect(chat.probe).toHaveBeenCalledOnce()
        expect(chat.catalogReads()).toBe(2)
      } finally {
        chat.hook.unmount()
      }
    }
  )

  it("shows a floating chat the account's listed default the host starts, not the first row", async () => {
    const haiku = { id: 'haiku', label: 'Haiku', isDefault: false, efforts: [LOW] }
    const chat = startingChat({ host: 'local', relists: [haiku, SONNET], floating: true })
    try {
      await waitFor(() =>
        expect(chat.row('model')).toMatchObject({
          valueSource: 'default',
          kind: { currentValue: 'sonnet' }
        })
      )
      expect(chat.probe).toHaveBeenCalledOnce()
    } finally {
      chat.hook.unmount()
    }
  })

  it('keeps the selection when an older host cannot say its list is current', async () => {
    const chat = startingChat({ host: 'paired', relists: [SONNET], olderHost: true })
    try {
      await waitFor(() => expect(chat.probe).toHaveBeenCalledOnce())
      await waitFor(() => expect(chat.catalogReads()).toBe(2))
      expect(chat.row('model')?.kind).not.toHaveProperty('currentValue')
      expect(chat.row('effort')).toBeUndefined()
    } finally {
      chat.hook.unmount()
    }
  })
})
