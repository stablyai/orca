import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../src/shared/runtime-types'

const PTY_ID = 'pty-0'
const WORKTREE_ID = 'workspace-0'
const TAB_ID = 'host-tab-0'
const LEAF_ID = '00000000-0000-4000-8000-000000000000'

type TerminalTab = Extract<RuntimeMobileSessionTabsSnapshot['tabs'][number], { type: 'terminal' }>

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  ptysById: Map<string, { lastAgentStatusRichInvalidatedAtEpochMs: number | null }>
  resetTrackedTerminalStateForProviderGeneration: (ptyId: string) => void
}

type Harness = {
  internals: RuntimeInternals
  publications: RuntimeMobileSessionTabsResult[]
  runtime: OrcaRuntimeService
  tab: TerminalTab
  unsubscribe: () => void
}

function createHarness(): Harness {
  const runtime = new OrcaRuntimeService()
  runtime.registerPty(PTY_ID, WORKTREE_ID)
  const tab: TerminalTab = {
    type: 'terminal',
    id: `${TAB_ID}::${LEAF_ID}`,
    parentTabId: TAB_ID,
    leafId: LEAF_ID,
    ptyId: PTY_ID,
    title: 'Cursor Agent',
    parentLayout: {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
    },
    isActive: true
  }
  const internals = runtime as unknown as RuntimeInternals
  internals.mobileSessionTabsByWorktree.set(WORKTREE_ID, {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-0',
    activeTabId: tab.id,
    activeTabType: 'terminal',
    tabs: [tab]
  })
  const publications: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
    publications.push(structuredClone(snapshot))
  })
  return { internals, publications, runtime, tab, unsubscribe }
}

function setRichStatus(
  tab: TerminalTab,
  args: { agentType?: 'claude' | 'cursor'; prompt: string; at: number }
): void {
  tab.agentStatus = {
    state: 'working',
    prompt: args.prompt,
    updatedAt: args.at,
    stateStartedAt: args.at,
    agentType: args.agentType ?? 'cursor',
    paneKey: tab.id,
    stateHistory: []
  }
}

function emitTitle(harness: Harness, title: string, at = Date.now()): void {
  harness.runtime.onPtyData(PTY_ID, `\x1b]0;${title}\x07`, at)
  vi.advanceTimersByTime(50)
}

function latestStatus(harness: Harness) {
  const terminal = harness.publications.at(-1)?.tabs[0]
  return terminal?.type === 'terminal' ? terminal.agentStatus : undefined
}

describe('session-tabs rich-status boundaries', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not renew a previous task across a done-to-working title boundary', () => {
    const harness = createHarness()
    const firstWorkingAt = Date.now()
    setRichStatus(harness.tab, { prompt: 'previous task', at: firstWorkingAt })
    emitTitle(harness, '⠋ Cursor Agent', firstWorkingAt)
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'bash')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    const nextWorkingAt = Date.now()
    emitTitle(harness, '⠙ Cursor Agent', nextWorkingAt)
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: '',
      updatedAt: nextWorkingAt,
      stateStartedAt: nextWorkingAt
    })
    harness.unsubscribe()
  })

  it('preserves the same task across a neutral title', () => {
    const harness = createHarness()
    const workingAt = Date.now()
    setRichStatus(harness.tab, { prompt: 'current task', at: workingAt })
    emitTitle(harness, '⠋ Cursor Agent', workingAt)

    harness.publications.length = 0
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'Terminal')
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: 'current task',
      updatedAt: workingAt,
      stateStartedAt: workingAt
    })

    harness.publications.length = 0
    vi.advanceTimersByTime(1)
    const resumedWorkingAt = Date.now()
    emitTitle(harness, '⠙ Cursor Agent', resumedWorkingAt)
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: 'current task',
      updatedAt: resumedWorkingAt,
      stateStartedAt: workingAt
    })
    harness.unsubscribe()
  })

  it('does not resurrect a task after neutral then shell titles', () => {
    const harness = createHarness()
    setRichStatus(harness.tab, { prompt: 'completed task', at: Date.now() })
    emitTitle(harness, '⠋ Cursor Agent')
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'Terminal')
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'bash')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    const nextWorkingAt = Date.now()
    emitTitle(harness, '⠙ Cursor Agent', nextWorkingAt)
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: '',
      updatedAt: nextWorkingAt,
      stateStartedAt: nextWorkingAt
    })
    harness.unsubscribe()
  })

  it('does not carry a stale question into the next title interval', () => {
    const harness = createHarness()
    const firstWorkingAt = Date.now()
    harness.tab.agentStatus = {
      state: 'waiting',
      prompt: 'previous question',
      interactivePrompt: '{"question":"previous question"}',
      updatedAt: firstWorkingAt,
      stateStartedAt: firstWorkingAt,
      agentType: 'cursor',
      paneKey: harness.tab.id,
      stateHistory: []
    }
    emitTitle(harness, 'Cursor Agent needs confirmation', firstWorkingAt)
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'bash')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    emitTitle(harness, '⠋ Cursor Agent')
    expect(latestStatus(harness)).toMatchObject({ state: 'working', prompt: '' })
    expect(latestStatus(harness)).not.toHaveProperty('interactivePrompt')
    harness.unsubscribe()
  })

  it('keeps a renderer question visible under a shell title until the next agent interval', () => {
    const harness = createHarness()
    const questionAt = Date.now()
    harness.tab.agentStatus = {
      state: 'waiting',
      prompt: 'current question',
      interactivePrompt: '{"question":"current question"}',
      updatedAt: questionAt,
      stateStartedAt: questionAt,
      agentType: 'cursor',
      paneKey: harness.tab.id,
      stateHistory: []
    }

    emitTitle(harness, 'bash')
    expect(latestStatus(harness)).toMatchObject({
      state: 'waiting',
      interactivePrompt: '{"question":"current question"}'
    })

    harness.publications.length = 0
    vi.advanceTimersByTime(1)
    emitTitle(harness, '⠋ Cursor Agent')
    expect(latestStatus(harness)).toMatchObject({ state: 'working', prompt: '' })
    expect(latestStatus(harness)).not.toHaveProperty('interactivePrompt')
    harness.unsubscribe()
  })

  it('keeps a retained OSC question visible under a shell title until the next agent interval', () => {
    const harness = createHarness()
    harness.runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: harness.tab.parentTabId,
      leafId: harness.tab.leafId
    })
    harness.runtime.onPtyData(
      PTY_ID,
      '\x1b]9999;{"state":"waiting","prompt":"current question","interactivePrompt":"question-payload","agentType":"cursor"}\x07',
      Date.now()
    )

    emitTitle(harness, 'bash')
    expect(latestStatus(harness)).toMatchObject({
      state: 'waiting',
      interactivePrompt: 'question-payload'
    })

    harness.publications.length = 0
    vi.advanceTimersByTime(1)
    emitTitle(harness, '⠋ Cursor Agent')
    expect(latestStatus(harness)).toMatchObject({ state: 'working', prompt: '' })
    expect(latestStatus(harness)).not.toHaveProperty('interactivePrompt')
    harness.unsubscribe()
  })

  it('does not resurrect retained status after an identity-only owner change', () => {
    const harness = createHarness()
    harness.runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: harness.tab.parentTabId,
      leafId: harness.tab.leafId
    })
    harness.runtime.onPtyData(
      PTY_ID,
      '\x1b]9999;{"state":"working","prompt":"retained task","agentType":"codex"}\x07',
      Date.now()
    )
    vi.advanceTimersByTime(50)
    emitTitle(harness, '⠋ Codex working')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    emitTitle(harness, 'Cursor Agent')
    expect(latestStatus(harness)).toMatchObject({ state: 'done', prompt: '' })
    harness.unsubscribe()
  })

  it('does not renew rich status from a replaced provider generation', () => {
    const harness = createHarness()
    const firstWorkingAt = Date.now()
    setRichStatus(harness.tab, { prompt: 'previous provider task', at: firstWorkingAt })
    emitTitle(harness, '⠋ Cursor Agent', firstWorkingAt)
    harness.tab.agentStatus!.updatedAt = Date.now()
    harness.internals.resetTrackedTerminalStateForProviderGeneration(PTY_ID)
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    const replacementWorkingAt = Date.now()
    emitTitle(harness, '⠙ Cursor Agent', replacementWorkingAt)
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: '',
      updatedAt: replacementWorkingAt,
      stateStartedAt: replacementWorkingAt
    })
    harness.unsubscribe()
  })

  it('keeps invalidation across an identity-only owner change', () => {
    const harness = createHarness()
    setRichStatus(harness.tab, {
      prompt: 'previous owner task',
      at: Date.now(),
      agentType: 'claude'
    })
    emitTitle(harness, '⠋ Claude working')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    const identityChangeAt = Date.now()
    emitTitle(harness, 'Cursor Agent', identityChangeAt)
    expect(harness.internals.ptysById.get(PTY_ID)?.lastAgentStatusRichInvalidatedAtEpochMs).toBe(
      identityChangeAt
    )
    expect(latestStatus(harness)).toBeUndefined()
    harness.unsubscribe()
  })
})
