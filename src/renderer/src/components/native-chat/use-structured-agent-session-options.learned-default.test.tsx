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
  AgentSessionModelOption,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

// The user's report: with no saved pick, every new Grok, OpenCode or OMP chat painted "Model" (or
// the probe's model) before the model the chat runs. The first chat with no pick is the only one
// that may: once it reports, the host names that model and the next chat starts from it.

const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' }
]

const CASES = {
  grok: { ids: ['grok-4.7', 'grok-4.6'], runs: 'grok-4.6', holdsEverywhere: true },
  opencode: {
    ids: ['github-copilot/gpt-6', 'github-copilot/claude-fable-5'],
    runs: 'github-copilot/claude-fable-5',
    holdsEverywhere: false
  }
} as const

type Case = (typeof CASES)[keyof typeof CASES]

function rows(entry: Case, named: boolean): AgentSessionModelOption[] {
  return entry.ids.map((id) => ({
    id,
    label: `${id} label`,
    isDefault: named && id === entry.runs,
    efforts: EFFORTS,
    ...(named && id === entry.runs ? { defaultEffort: 'high' } : {})
  }))
}

/** What the host answers before and after the first no-pick chat reports what it runs. */
function hostAnswer(entry: Case, named: boolean): AgentSessionModelCatalogResult {
  return {
    origin: 'live-session',
    models: rows(entry, named),
    fetchedAt: 1_000,
    listingNamesConfiguredModel: named,
    ...(named && entry.holdsEverywhere ? { defaultHoldsInEveryWorkspace: true as const } : {})
  }
}

type Pill = { model: string | null; effort: string | null }

function pill(snapshot: readonly SessionOptionDescriptor[]): Pill {
  const model = snapshot.find((entry) => entry.id === 'model')
  const effort = snapshot.find((entry) => entry.id === 'effort')
  return {
    model: model?.kind.type === 'select' ? (model.kind.currentValue ?? null) : null,
    effort: effort?.kind.type === 'select' ? (effort.kind.currentValue ?? null) : null
  }
}

const LOCAL = { kind: 'local' } as const
const NOT_STARTED: { running: { fence: number } | null } = { running: null }
const NO_HELD = {}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no pick is made, so mutate is never called.
const NO_MUTATE = vi.fn() as unknown as StructuredAgentSessionMutate

function renderChat(agent: string, sessionId: string, worktree: string) {
  const frames: Pill[] = []
  // Stable across renders, as the pane's own props are: a new object would re-run every read.
  const launch = { kind: 'new' as const, heldOptions: NO_HELD, worktree }
  const view = renderHook(
    ({ running }: { running: { fence: number } | null }) => {
      const options = useStructuredAgentSessionOptions({
        agent,
        sessionId,
        target: LOCAL,
        transportEnabled: running !== null,
        isVisible: true,
        providerVisible: running !== null,
        fence: running?.fence ?? null,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate: NO_MUTATE,
        launch
      })
      frames.push(pill(options.optionSnapshot))
      return options
    },
    { initialProps: NOT_STARTED }
  )
  return { frames, ...view }
}

/** A first chat that named no model: the pane reads the host before the chat starts, then the
 *  chat starts and its options are read. */
async function firstChatRuns(agent: keyof typeof CASES, worktree: string) {
  const first = renderChat(agent, `${agent}-1`, worktree)
  await waitFor(() =>
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.modelCatalog',
      expect.anything()
    )
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  // Nothing was known: the first chat names its model only once it reports.
  expect(first.frames.every((frame) => frame.model === null)).toBe(true)
  first.rerender({ running: { fence: 1 } })
  await waitFor(() =>
    expect(first.frames.at(-1)).toEqual({ model: CASES[agent].runs, effort: 'high' })
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  return first
}

describe('a second new chat after one that named no model', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  function hostFor(agent: keyof typeof CASES): void {
    const entry = CASES[agent]
    // Per test: a late read from an earlier test's chat must not teach this host anything.
    let reported = false
    mocks.call.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'agentSession.modelCatalog') {
        return hostAnswer(entry, reported)
      }
      if (method === 'agentSession.options') {
        // The host learns the configured default as this read answers, after any catalog read
        // sent alongside it.
        await new Promise((resolve) => setTimeout(resolve, 5))
        reported = true
        const answer: AgentSessionOptionsResult = {
          models: rows(entry, false),
          current: { model: entry.runs, effort: 'high', confirmed: ['model', 'effort'] }
        }
        return answer
      }
      return new Promise(() => {})
    })
  }

  it.each(['grok', 'opencode'] as const)(
    '%s: names the model the first chat ran on its first frame',
    async (agent) => {
      hostFor(agent)
      const first = await firstChatRuns(agent, 'id:wt-1')

      const second = renderChat(agent, `${agent}-2`, 'id:wt-1')
      expect(second.frames[0]).toEqual({ model: CASES[agent].runs, effort: 'high' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        second.frames.every((frame) => frame.model === CASES[agent].runs && frame.effort === 'high')
      ).toBe(true)
      first.unmount()
      second.unmount()
    }
  )

  it('grok: a chat in another worktree starts from it too, since no project config moves it', async () => {
    hostFor('grok')
    const first = await firstChatRuns('grok', 'id:wt-1')
    const elsewhere = renderChat('grok', 'grok-2', 'id:wt-2')
    expect(elsewhere.frames[0]).toEqual({ model: 'grok-4.6', effort: 'high' })
    first.unmount()
    elsewhere.unmount()
  })
})
