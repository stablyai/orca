// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

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
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

// Windows QA: a new chat at rest, a model and effort picked in it, then the first message. The
// message starts the agent under a new fence, and while it starts the disabled pickers showed the
// listing's default instead of the pick, until the start was proven.

const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

const CASES = {
  codex: {
    listed: ['gpt-6.1-sol', 'gpt-6.1-terra'],
    pick: { model: 'gpt-6.1-terra', effort: 'high' }
  },
  grok: { listed: ['grok-build', 'grok-4.7'], pick: { model: 'grok-4.7', effort: 'low' } },
  pi: {
    listed: ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet'],
    pick: { model: 'anthropic/claude-sonnet', effort: 'high' }
  }
} as const

const LOCAL = { kind: 'local' } as const

type Pill = { model: string | null; effort: string | null }

function pill(snapshot: readonly SessionOptionDescriptor[]): Pill {
  const value = (id: string) => {
    const entry = snapshot.find((descriptor) => descriptor.id === id)
    return entry?.kind.type === 'select' ? (entry.kind.currentValue ?? null) : null
  }
  return { model: value('model'), effort: value('effort') }
}

beforeEach(() => {
  mocks.call.mockReset()
  resetHostModelCatalogSnapshotsForTests()
})

for (const [agent, entry] of Object.entries(CASES)) {
  it(`keeps showing a ${agent} chat's pick while its first message starts the agent`, async () => {
    const models = entry.listed.map((id, index) => ({
      id,
      label: `${id} label`,
      isDefault: index === 0,
      efforts: EFFORTS,
      ...(index === 0 ? { defaultEffort: 'medium' } : {})
    }))
    const catalog: AgentSessionModelCatalogResult = {
      origin: 'live-session',
      models,
      fetchedAt: 1_000,
      listingNamesConfiguredModel: true
    }
    // The host's answer: the listing's default until the pick is saved, then the pick.
    let saved: Readonly<Record<string, string>> = {}
    const options = (): AgentSessionOptionsResult => ({
      models,
      current: { model: saved.model ?? entry.listed[0], effort: saved.effort ?? 'medium' },
      rewind: { supported: false, reason: 'unsupported' }
    })
    mocks.call.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.modelCatalog' ? catalog : options()
    )
    const mutate = vi.fn(async (_method: string, _op: string, fields: unknown) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook sends { key, value } to setOption.
      const { key, value } = fields as { key: string; value: string }
      saved = { ...saved, [key]: value }
      return { key, value, options: saved }
    })
    const frames: Pill[] = []
    // Stable across renders, as the pane's own props are.
    const launch = { kind: 'new' as const, heldOptions: {} }
    const { result, rerender, unmount } = renderHook(
      (props: { fence: number; starting: boolean }) => {
        const view = useStructuredAgentSessionOptions({
          agent,
          sessionId: `${agent}-session`,
          target: LOCAL,
          transportEnabled: true,
          isVisible: true,
          providerVisible: true,
          providerStarting: props.starting,
          fence: props.fence,
          turnId: null,
          unloadedTurnRevisions: undefined,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply is the AgentSessionOptionResult shape the hook reads.
          mutate: mutate as unknown as StructuredAgentSessionMutate,
          launch
        })
        frames.push(pill(view.optionSnapshot))
        return view
      },
      { initialProps: { fence: 1, starting: false } }
    )
    await waitFor(() => expect(pill(result.current.optionSnapshot).model).toBe(entry.listed[0]))
    await act(async () => {
      await result.current.setStructuredOption('model', entry.pick.model)
    })
    await act(async () => {
      await result.current.setStructuredOption('effort', entry.pick.effort)
    })
    await waitFor(() => expect(pill(result.current.optionSnapshot)).toEqual(entry.pick))

    // The first message: the host publishes the agent it is starting under the next fence.
    const sent = frames.length
    rerender({ fence: 2, starting: true })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    // The start is proven and the host's live answer names the pick.
    rerender({ fence: 2, starting: false })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(frames.slice(sent).filter((frame) => frame.model !== entry.pick.model)).toEqual([])
    expect(frames.slice(sent).filter((frame) => frame.effort !== entry.pick.effort)).toEqual([])
    unmount()
  })
}
