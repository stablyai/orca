import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { ReviewNotesSendMenuContent } from './ReviewNotesSendMenuContent'
import {
  buildSingleTargetScenario,
  collectText,
  createAgentRowFactory,
  expand,
  findAllByType,
  findByType,
  leafLayout,
  sendTargetRowText,
  tab,
  JUNK_TITLES,
  type SingleTargetScenario,
  LEAF_A,
  LEAF_B,
  TAB_A,
  TAB_B
} from './notes-send-menu-test-fixtures'

const agentRow = createAgentRowFactory(600_000)

const hookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  cleanups: [] as (() => void)[]
}))

const harness = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
  sendNotesToActiveAgentSession: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  worktreeAgentRows: [] as DashboardAgentRowData[],
  noteTargets: [] as {
    paneKey: string
    tabId: string
    leafId: string
    agentType: TuiAgent
    tab: ReturnType<typeof tab>
    status: 'eligible' | 'disabled'
    disabledReason?: string
  }[],
  now: 600_000
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback<T extends (...args: never[]) => unknown>(callback: T): T {
      return callback
    },
    useMemo<T>(factory: () => T): T {
      return factory()
    },
    useEffect(effect: () => void | (() => void)): void {
      const cleanup = effect()
      if (typeof cleanup === 'function') {
        hookRuntime.cleanups.push(cleanup)
      }
    },
    useState<T>(initial: T | (() => T)) {
      const stateIndex = hookRuntime.index++
      if (!(stateIndex in hookRuntime.states)) {
        hookRuntime.states[stateIndex] =
          typeof initial === 'function' ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((previous: T) => T)): void => {
        hookRuntime.states[stateIndex] =
          typeof next === 'function'
            ? (next as (previous: T) => T)(hookRuntime.states[stateIndex] as T)
            : next
      }
      return [hookRuntime.states[stateIndex] as T, setState] as const
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(harness.storeState),
    {
      getState: () => harness.storeState
    }
  )
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status),
  sendNotesToActiveAgentSession: harness.sendNotesToActiveAgentSession,
  useCanSendNotesToActiveTerminal: () => true
}))

vi.mock('@/lib/notes-send-agent-targets', () => ({
  deriveNotesSendAgentTargets: () => harness.noteTargets
}))

vi.mock('@/lib/telemetry', () => ({
  track: harness.track
}))

vi.mock('@/components/dashboard/useNow', () => ({
  useNow: () => harness.now
}))

vi.mock('@/components/sidebar/useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: () => harness.worktreeAgentRows
}))

vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: function AgentStateDot(props: Record<string, unknown>) {
    return { type: 'AgentStateDot', props }
  },
  agentStateLabel: (state: string) => {
    switch (state) {
      case 'working':
        return 'Working'
      case 'blocked':
        return 'Blocked'
      case 'waiting':
        return 'Waiting for input'
      case 'done':
        return 'Done'
      case 'idle':
        return 'Idle'
      default:
        return state
    }
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: function AgentIcon(props: Record<string, unknown>) {
    return { type: 'AgentIcon', props }
  }
}))

vi.mock('@/components/tab-bar/QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: function QuickLaunchAgentMenuItems(props: Record<string, unknown>) {
    return { type: 'QuickLaunchAgentMenuItems', props }
  }
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: function DropdownMenuItem(props: Record<string, unknown>) {
    return { type: 'DropdownMenuItem', props }
  },
  DropdownMenuLabel: function DropdownMenuLabel(props: Record<string, unknown>) {
    return { type: 'DropdownMenuLabel', props }
  },
  DropdownMenuSeparator: function DropdownMenuSeparator(props: Record<string, unknown>) {
    return { type: 'DropdownMenuSeparator', props }
  }
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    message: harness.toastMessage,
    success: vi.fn()
  }
}))

function setStore(overrides: Record<string, unknown> = {}): void {
  harness.storeState = {
    activeWorktreeId: 'wt-1',
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    tabsByWorktree: { 'wt-1': [] },
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    ...overrides
  }
}

function render(props: Record<string, unknown> = {}): unknown {
  hookRuntime.index = 0
  return expand(
    <ReviewNotesSendMenuContent worktreeId="wt-1" groupId="group-1" prompt="my notes" {...props} />
  )
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('ReviewNotesSendMenuContent', () => {
  beforeEach(() => {
    hookRuntime.states = []
    hookRuntime.index = 0
    hookRuntime.cleanups = []
    harness.sendNotesToActiveAgentSession.mockReset()
    harness.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
    harness.track.mockReset()
    harness.toastMessage.mockReset()
    harness.worktreeAgentRows = []
    harness.noteTargets = []
    harness.now = 600_000
    setStore()
  })

  it('enumerates each running agent of the worktree as a send target', () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: {
        'wt-1': [
          tab(TAB_A, { title: 'Terminal 1' }),
          tab(TAB_B, { title: 'Codex', launchAgent: 'codex' })
        ]
      },
      terminalLayoutsByTabId: {
        [TAB_A]: leafLayout(LEAF_A, 'pty-a'),
        [TAB_B]: leafLayout(LEAF_B, 'pty-b')
      }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A),
        status: 'eligible'
      },
      {
        paneKey: makePaneKey(TAB_B, LEAF_B),
        tabId: TAB_B,
        leafId: LEAF_B,
        agentType: 'codex',
        tab: tab(TAB_B),
        status: 'eligible'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.props.disabled === false)).toBe(true)
    expect(collectText(items[0])).toContain('Claude')
    expect(collectText(items[1])).toContain('Codex')
  })

  function renderSingleTarget(scenario: SingleTargetScenario): { name: string; detail: string } {
    const built = buildSingleTargetScenario(scenario, makePaneKey(TAB_A, LEAF_A), agentRow)
    harness.worktreeAgentRows = built.agentRows
    setStore(built.store)
    harness.noteTargets = built.noteTargets as typeof harness.noteTargets
    return sendTargetRowText(findByType(render(), 'DropdownMenuItem'))
  }

  it('leads with the tab name and demotes the agent harness to the detail line', () => {
    const row = renderSingleTarget({ title: 'teste', agentType: 'claude' })

    expect(row.name).toBe('teste')
    expect(row.detail).toBe('Claude · Idle · just now')
  })

  it.each(JUNK_TITLES)(
    'falls through a %s to what the agent is working on',
    (_case, title, agentType) => {
      const row = renderSingleTarget({ title, agentType, prompt: 'fix the login bug' })

      expect(row.name).toBe('fix the login bug')
    }
  )

  it.each(JUNK_TITLES)(
    'falls through a %s to the tab ordinal when there is no live work',
    (_case, title, agentType) => {
      const row = renderSingleTarget({ title, agentType })

      expect(row.name).toBe('Terminal 3')
    }
  )

  it('falls through to the tab ordinal for a title-hint target with no agent row', () => {
    const row = renderSingleTarget({
      title: '✳ Claude',
      agentType: 'claude',
      withAgentRow: false
    })

    expect(row.name).toBe('Terminal 3')
    expect(row.detail).toBe('Claude · Idle')
  })

  it('keeps a manual rename, a quick-command label, and a generated title', () => {
    expect(
      renderSingleTarget({
        title: '✳ Add validation',
        agentType: 'claude',
        prompt: 'fix the login bug',
        tabOverrides: { customTitle: 'Designer' }
      }).name
    ).toBe('Designer')
    expect(
      renderSingleTarget({
        title: '✳ Add validation',
        agentType: 'claude',
        prompt: 'fix the login bug',
        tabOverrides: { quickCommandLabel: 'Run tests' }
      }).name
    ).toBe('Run tests')
    expect(
      renderSingleTarget({
        title: 'Codex ready',
        agentType: 'codex',
        prompt: 'fix the login bug',
        tabOverrides: { generatedTitle: 'Refactor auth' },
        generatedTitlesEnabled: true
      }).name
    ).toBe('Refactor auth')
    // Why: with the setting off the generated title must not resurface — and the
    // stale synthetic status behind it is not a name either.
    expect(
      renderSingleTarget({
        title: 'Codex ready',
        agentType: 'codex',
        prompt: 'fix the login bug',
        tabOverrides: { generatedTitle: 'Refactor auth' }
      }).name
    ).toBe('fix the login bug')
  })

  it('keeps three unnamed idle tabs distinguishable by their ordinals', () => {
    const tabs = [
      { tabId: TAB_A, leafId: LEAF_A, ordinal: 'Terminal 3' },
      { tabId: TAB_B, leafId: LEAF_B, ordinal: 'Terminal 4' },
      { tabId: 'tab-c', leafId: '33333333-3333-4333-8333-333333333333', ordinal: 'Terminal 5' }
    ]
    harness.worktreeAgentRows = []
    setStore({
      tabsByWorktree: {
        'wt-1': tabs.map((t) => tab(t.tabId, { title: '✳ Claude', defaultTitle: t.ordinal }))
      },
      terminalLayoutsByTabId: Object.fromEntries(
        tabs.map((t) => [t.tabId, leafLayout(t.leafId, `pty-${t.tabId}`)])
      )
    })
    harness.noteTargets = tabs.map((t) => ({
      paneKey: makePaneKey(t.tabId, t.leafId),
      tabId: t.tabId,
      leafId: t.leafId,
      agentType: 'claude' as TuiAgent,
      tab: tab(t.tabId, { title: '✳ Claude', defaultTitle: t.ordinal }),
      status: 'eligible' as const
    }))

    const names = findAllByType(render(), 'DropdownMenuItem').map(
      (item) => sendTargetRowText(item).name
    )

    expect(names).toEqual(['Terminal 3', 'Terminal 4', 'Terminal 5'])
  })

  it('does not repeat the parent tab name on a same-tab child row', () => {
    const parentPaneKey = makePaneKey(TAB_A, LEAF_A)
    const childPaneKey = makePaneKey(TAB_A, LEAF_B)
    const parentTab = tab(TAB_A, { customTitle: 'Designer' })
    const child = agentRow({
      paneKey: childPaneKey,
      tabId: TAB_A,
      title: '✳ Claude',
      agentType: 'claude',
      state: 'idle',
      prompt: 'write the docs',
      tabOverrides: { customTitle: 'Designer' }
    })
    child.lineage = { depth: 1, isFirstSibling: true, isLastSibling: true, childCount: 0 }
    child.entry.orchestration = { parentPaneKey, taskId: 'task-1', dispatchId: 'dispatch-1' }
    harness.worktreeAgentRows = [
      agentRow({
        paneKey: parentPaneKey,
        tabId: TAB_A,
        title: '✳ Claude',
        agentType: 'claude',
        state: 'idle',
        tabOverrides: { customTitle: 'Designer' }
      }),
      child
    ]
    setStore({
      tabsByWorktree: { 'wt-1': [parentTab] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [parentPaneKey, childPaneKey].map((paneKey, index) => ({
      paneKey,
      tabId: TAB_A,
      leafId: index === 0 ? LEAF_A : LEAF_B,
      agentType: 'claude' as TuiAgent,
      tab: parentTab,
      status: 'eligible' as const
    }))

    const names = findAllByType(render(), 'DropdownMenuItem').map(
      (item) => sendTargetRowText(item).name
    )

    expect(names).toEqual(['Designer', 'write the docs'])
  })

  it('promotes the harness label when the target has no name at all', () => {
    const row = renderSingleTarget({
      title: '',
      agentType: 'claude',
      tabOverrides: { defaultTitle: undefined }
    })

    expect(row.name).toBe('Claude')
    expect(row.detail).toBe('Idle · just now')
  })

  it('orders send targets by the current worktree agent rows and shows status timing', () => {
    const paneKeyA = makePaneKey(TAB_A, LEAF_A)
    const paneKeyB = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey: paneKeyB,
        tabId: TAB_B,
        title: 'Second session',
        agentType: 'codex',
        startedAt: harness.now - 120_000
      }),
      agentRow({
        paneKey: paneKeyA,
        tabId: TAB_A,
        title: 'First session',
        agentType: 'claude',
        startedAt: harness.now - 60_000
      })
    ]
    setStore({
      tabsByWorktree: {
        'wt-1': [tab(TAB_A, { title: 'First session' }), tab(TAB_B, { title: 'Second session' })]
      },
      terminalLayoutsByTabId: {
        [TAB_A]: leafLayout(LEAF_A, 'pty-a'),
        [TAB_B]: leafLayout(LEAF_B, 'pty-b')
      }
    })
    harness.noteTargets = [
      {
        paneKey: paneKeyA,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A, { title: 'First session' }),
        status: 'eligible'
      },
      {
        paneKey: paneKeyB,
        tabId: TAB_B,
        leafId: LEAF_B,
        agentType: 'codex',
        tab: tab(TAB_B, { title: 'Second session' }),
        status: 'eligible'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(2)
    expect(collectText(items[0])).toContain('Codex')
    expect(collectText(items[0])).toContain('Done')
    expect(collectText(items[0])).toContain('2m ago')
    expect(collectText(items[0])).toContain('Second session')
    expect(collectText(items[1])).toContain('Claude')
  })

  it('does not target title-detected rows skipped by target derivation', async () => {
    const paneKey = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey,
        tabId: TAB_B,
        title: 'Codex',
        agentType: 'codex',
        state: 'idle',
        startedAt: harness.now
      })
    ]
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_B, { title: 'Codex' })] },
      terminalLayoutsByTabId: { [TAB_B]: leafLayout(LEAF_B, 'pty-b') },
      ptyIdsByTabId: { [TAB_B]: ['pty-b'] }
    })

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(0)
    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
  })

  it('disables title-detected dashboard rows when target derivation reports permission', () => {
    const paneKey = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey,
        tabId: TAB_B,
        title: 'Codex',
        agentType: 'codex',
        state: 'blocked',
        startedAt: harness.now
      })
    ]
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_B, { title: 'Codex' })] },
      terminalLayoutsByTabId: { [TAB_B]: leafLayout(LEAF_B, 'pty-b') },
      ptyIdsByTabId: { [TAB_B]: ['pty-b'] }
    })
    harness.noteTargets = [
      {
        paneKey,
        tabId: TAB_B,
        leafId: LEAF_B,
        agentType: 'codex',
        tab: tab(TAB_B),
        status: 'disabled',
        disabledReason: 'Agent needs permission'
      }
    ]

    const tree = render()
    const item = findByType(tree, 'DropdownMenuItem')

    expect(item.props.disabled).toBe(true)
    expect(item.props.title).toBe('Agent needs permission')
    ;(item.props.onSelect as () => void)()
    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
  })

  it('does not offer a title-detected agent row after its live PTY has exited', () => {
    const paneKey = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey,
        tabId: TAB_B,
        title: 'Codex',
        agentType: 'codex',
        state: 'done',
        startedAt: harness.now - 60_000
      })
    ]
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_B, { title: 'Codex' })] },
      terminalLayoutsByTabId: { [TAB_B]: leafLayout(LEAF_B, 'pty-b') },
      ptyIdsByTabId: { [TAB_B]: [] }
    })

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(0)
    expect(collectText(tree)).not.toContain('Active agent session')
  })

  it('does not render an active agent fallback alongside named targets', () => {
    const listedPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A), tab(TAB_B)] },
      terminalLayoutsByTabId: {
        [TAB_A]: leafLayout(LEAF_A, 'pty-a'),
        [TAB_B]: leafLayout(LEAF_B, 'pty-b')
      }
    })
    harness.noteTargets = [
      {
        paneKey: listedPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A),
        status: 'eligible'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(1)
    expect(collectText(items[0])).toContain('Claude')
    expect(collectText(tree)).not.toContain('Active agent session')
    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
  })

  it('does not render an active agent fallback when the matching derived row is disabled', () => {
    const paneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Codex' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'codex',
        tab: tab(TAB_A),
        status: 'disabled',
        disabledReason: 'Agent status is stale'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(1)
    expect(items[0].props.disabled).toBe(true)
    expect(collectText(tree)).not.toContain('Active agent session')
  })

  it('sends notes to the chosen agent and tracks the send once it succeeds', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    const onPromptDelivered = vi.fn()
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A),
        status: 'eligible'
      }
    ]

    const tree = render({ onPromptDelivered })
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()
    await flushMicrotasks()

    expect(harness.sendNotesToActiveAgentSession).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      prompt: 'my notes',
      noteTarget: { tabId: TAB_A, leafId: LEAF_A }
    })
    expect(onPromptDelivered).toHaveBeenCalledTimes(1)
    expect(harness.track).toHaveBeenCalledWith('agent_prompt_sent', {
      agent_kind: 'claude-code',
      launch_source: 'notes_send',
      request_kind: 'followup'
    })
  })

  it('keeps selected-target note failures undelivered and uses selected wording', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    const onPromptDelivered = vi.fn()
    harness.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'not-ready' })
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A),
        status: 'eligible'
      }
    ]

    const tree = render({ onPromptDelivered })
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()
    await flushMicrotasks()

    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(harness.track).not.toHaveBeenCalled()
    expect(harness.toastMessage).toHaveBeenCalledWith('selected:not-ready')
  })

  it('keeps selected-target thrown send errors undelivered', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    const onPromptDelivered = vi.fn()
    harness.sendNotesToActiveAgentSession.mockRejectedValue(new Error('runtime unavailable'))
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A),
        status: 'eligible'
      }
    ]

    const tree = render({ onPromptDelivered })
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()
    await flushMicrotasks()

    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(harness.track).not.toHaveBeenCalled()
  })

  it('revalidates the chosen target at click time and refuses stale rows', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') },
      ptyIdsByTabId: { [TAB_A]: ['pty-a'] }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A),
        status: 'eligible'
      }
    ]

    const tree = render()
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A),
        status: 'disabled',
        disabledReason: 'Agent status is stale'
      }
    ]
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()

    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
    expect(harness.toastMessage).toHaveBeenCalledWith('Agent status is stale')
  })

  it('refuses stale menu targets that disappear from target derivation before click', () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') },
      ptyIdsByTabId: { [TAB_A]: ['pty-a'] }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A),
        status: 'eligible'
      }
    ]

    const tree = render()
    harness.noteTargets = []
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()

    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
    expect(harness.toastMessage).toHaveBeenCalledWith('Terminal is no longer available')
  })

  it('keeps a working agent selectable and preserves the Working state text', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') },
      ptyIdsByTabId: { [TAB_A]: ['pty-a'] }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tab: tab(TAB_A),
        status: 'eligible'
      }
    ]
    harness.worktreeAgentRows = [
      agentRow({
        paneKey: statusPaneKey,
        tabId: TAB_A,
        title: 'Terminal 1',
        agentType: 'claude',
        state: 'working'
      })
    ]

    const tree = render()
    const item = findByType(tree, 'DropdownMenuItem')

    expect(item.props.disabled).toBe(false)
    expect(collectText(item)).toContain('Working')
    ;(item.props.onSelect as () => void)()
    await flushMicrotasks()
    expect(harness.sendNotesToActiveAgentSession).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      prompt: 'my notes',
      noteTarget: { tabId: TAB_A, leafId: LEAF_A }
    })
  })

  it('does not render an active agent fallback when no agents are derived', () => {
    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(0)
    expect(collectText(tree)).not.toContain('Active agent session')
    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
  })

  it('always offers the new-agent launcher', () => {
    const tree = render()

    expect(findByType(tree, 'QuickLaunchAgentMenuItems').props).toMatchObject({
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: 'my notes',
      launchSource: 'notes_send'
    })
  })
})
