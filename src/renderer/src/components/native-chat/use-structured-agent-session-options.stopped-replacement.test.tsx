// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session-wire'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

// A stopped chat reopened more than a minute after its account was last listed: the host answers
// its options with the saved model while it re-lists, and only that listing can call the model
// gone. The picker must then show what the next start runs, before anything is sent.

const MODELS = [
  { id: 'opus', label: 'Opus', isDefault: true, efforts: [] },
  { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }
]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

// Stable across renders, as the pane's own props are: a new object would re-run every read.
const LOCAL = { kind: 'local' } as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no pick is made, so mutate is never called.
const NO_MUTATE = vi.fn() as unknown as StructuredAgentSessionMutate

describe('a stopped chat whose saved model the re-listing finds gone', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  it('shows the replacement once the listing lands, with no send', async () => {
    const listed = deferred<AgentSessionModelCatalogResult>()
    const optionReads: AgentSessionOptionsResult[] = [
      { models: MODELS, current: { model: 'gone' } },
      { models: MODELS, current: { model: 'opus' } }
    ]
    let reads = 0
    mocks.call.mockImplementation((_target: unknown, method: string, params: unknown) => {
      if (method === 'agentSession.options') {
        return Promise.resolve(optionReads[Math.min(reads++, optionReads.length - 1)])
      }
      if (method === 'agentSession.modelCatalog') {
        return typeof params === 'object' && params !== null && 'waitForListing' in params
          ? listed.promise
          : Promise.resolve({
              origin: 'probe',
              models: MODELS,
              fetchedAt: 1_000,
              listingInProgress: true
            })
      }
      return new Promise(() => {})
    })
    const view = renderHook(() =>
      useStructuredAgentSessionOptions({
        agent: 'claude',
        sessionId: 'stopped-chat',
        target: LOCAL,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        fence: 3,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate: NO_MUTATE
      })
    )
    const shownModel = () => {
      const model = view.result.current.optionSnapshot.find((entry) => entry.id === 'model')
      return model?.kind.type === 'select' ? model.kind.currentValue : undefined
    }
    await waitFor(() => expect(shownModel()).toBe('gone'))

    listed.resolve({
      origin: 'probe',
      models: MODELS,
      fetchedAt: 2_000,
      unlistedModelReplacement: 'opus'
    })
    await waitFor(() => expect(shownModel()).toBe('opus'))
    expect(reads).toBe(2)
    expect(NO_MUTATE).not.toHaveBeenCalled()
  })
})
