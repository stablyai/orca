// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { createRef, type KeyboardEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { AgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/structured-agent-session-projection'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import type { AiVaultSessionListKeyboard } from './use-ai-vault-session-keyboard-navigation'
import type { AiVaultResumeHere } from './ai-vault-session-resume-here'

const VIEWPORT_PX = 600
const ROW_PX = 98

// The rich row is covered by its own tests; here only which row is selected matters.
vi.mock('./AiVaultSessionRow', () => ({
  VaultSessionRow: (props: { session: AiVaultSession }) => <div>{props.session.title}</div>
}))
// The host's side of a resumed chat: it admits the chat, then the launch settles as the test says.
const launch = vi.hoisted(
  (): { sessionId: string; settlement: StructuredAgentLaunchSettlement } => ({
    sessionId: 'new',
    settlement: { kind: 'structured', sessionId: 'new' }
  })
)
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: async (session: AiVaultSession) => session
}))
vi.mock('@/lib/agent-session-launch-plan', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adoptAgentSessionLaunchVerdict: (verdict: AgentSessionLaunchVerdict) => ({
    ...verdict,
    begin: () => ({
      sessionId: launch.sessionId,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      settlement: Promise.resolve(launch.settlement),
      cancel: vi.fn()
    })
  })
}))
vi.mock('@/lib/structured-agent-session-launch-admission', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginHostAdmittedStructuredLaunch: (args: {
    openAdmitted: () => { settlement: Promise<StructuredAgentLaunchSettlement> } | null
  }) => ({
    sessionId: null,
    tab: null,
    settlement: args.openAdmitted()?.settlement,
    cancel: vi.fn()
  })
}))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
const observation = vi.hoisted(() => ({ value: 'live' }))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    getSessionObservation: () => observation.value,
    getSnapshot: () => new Map()
  })
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: vi.fn()
}))
// Opening a chat by id: switches to its tab, or the host republishes a closed one as a new tab.
vi.mock('@/lib/activate-ai-vault-structured-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activateAiVaultStructuredSession: vi.fn(
    async ({
      structuredSession: s
    }: {
      structuredSession: { sessionId: string; workspaceId: string }
    }) => {
      const tabs = useAppStore.getState().unifiedTabsByWorktree[s.workspaceId] ?? []
      if (!tabs.some((tab) => tab.entityId === s.sessionId)) {
        useAppStore.getState().createUnifiedTab(s.workspaceId, 'agent-session', {
          id: s.sessionId,
          entityId: s.sessionId,
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          agentSessionAgent: 'claude'
        })
      }
      return true
    }
  )
}))

import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function session(n: number): AiVaultSession {
  return {
    id: `local:claude:s-${n}`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: `s-${n}`,
    title: `Session ${n}`,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/s-${n}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-17T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [{ role: 'user', text: 'Fix it', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `claude --resume s-${n}`,
    subagent: null
  }
}

const sessions = Array.from({ length: 30 }, (_, n) => session(n))

function renderList(
  options: {
    groups?: AiVaultSessionListGroup[]
    collapsedGroups?: ReadonlySet<string>
    openSessionIds?: ReadonlySet<string>
    eligible?: (session: AiVaultSession) => boolean
    resumeHere?: AiVaultResumeHere
  } = {}
) {
  const keyboard = createRef<AiVaultSessionListKeyboard>()
  const calls = {
    onJumpToOriginalPane: vi.fn(),
    onResumeInNewChat: vi.fn(),
    onResume: vi.fn()
  }
  const groups = options.groups ?? [{ key: 'all', label: null, sessions }]
  const list = (query: string) => (
    <AiVaultSessionVirtualList
      query={query}
      groups={groups}
      collapsedGroups={options.collapsedGroups ?? new Set()}
      loading={false}
      sessionsCount={sessions.length}
      filteredSessionsCount={sessions.length}
      noAgentsSelected={false}
      error={null}
      vaultScope="workspace"
      buildResumeStartup={() => ({ command: '' })}
      getOriginalPaneTarget={() => null}
      isStructuredSessionOpen={(s) => options.openSessionIds?.has(s.id) ?? false}
      getSessionLiveState={() => null}
      getWorktreeInfo={() => null}
      getSessionResumeState={() => ({
        blocked: false,
        worktreeId: 'wt-1',
        usesSessionWorktree: true
      })}
      getSessionResumeActions={() => ({
        worktree: { worktreeId: null, disabled: true },
        newTab: { worktreeId: 'wt-1', disabled: false }
      })}
      getSessionResumeInChat={(s) =>
        (options.eligible?.(s) ?? true)
          ? {
              available: true,
              workspaceId: options.resumeHere?.workspaceId ?? `own-${s.sessionId}`
            }
          : { available: false, reason: 'remote' }
      }
      onToggleGroup={vi.fn()}
      onJumpToOriginalPane={calls.onJumpToOriginalPane}
      onJumpToWorktree={vi.fn()}
      onResume={calls.onResume}
      onContinueInNewSession={vi.fn()}
      onResumeInNewChat={calls.onResumeInNewChat}
      onResumeInNewCli={vi.fn()}
      onCopyResume={vi.fn()}
      onCopyId={vi.fn()}
      onCopyPath={vi.fn()}
      onOpenLog={vi.fn()}
      onRevealLog={vi.fn()}
      onOpenCwd={vi.fn()}
      onRequestDelete={vi.fn()}
      keyboardRef={keyboard}
      resumeHere={options.resumeHere}
    />
  )
  const view = render(list(''))
  const press = (key: string, repeat = false) => {
    const event = { key, repeat, preventDefault: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only key, modifiers, repeat and preventDefault.
    act(() => keyboard.current?.handleKeyDown(event as unknown as KeyboardEvent<HTMLElement>))
    return event
  }
  return { calls, press, search: (query: string) => view.rerender(list(query)) }
}

function selectedTitle(): string | null {
  return document.querySelector('[data-selected="true"]')?.textContent ?? null
}

beforeEach(() => {
  toastError.mockClear()
  // Why: happy-dom has no layout; give the virtualizer a bounded viewport and fixed rows.
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('overflow-y-auto') ? VIEWPORT_PX : ROW_PX
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const isScroller = this.classList.contains('overflow-y-auto')
    return new DOMRect(0, 0, 400, isScroller ? VIEWPORT_PX : ROW_PX)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Session History keyboard selection', () => {
  it('moves over sessions only, clamped, and a listed-twice session does not trap it', () => {
    const { press } = renderList({
      groups: [
        { key: 'a', label: 'Alpha', sessions: [sessions[0], sessions[1]] },
        { key: 'b', label: 'Beta', sessions: sessions.slice(2, 4) },
        { key: 'c', label: 'Gamma', sessions: [sessions[1], sessions[4]] }
      ],
      collapsedGroups: new Set(['b'])
    })
    expect(selectedTitle()).toBe('Session 0')
    expect(press('ArrowUp').preventDefault).toHaveBeenCalled()
    expect(selectedTitle()).toBe('Session 0')
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown')
    expect(selectedTitle()).toBe('Session 4')
  })

  it('starts again at the top match when the search text changes', () => {
    const { press, search } = renderList()
    press('ArrowDown')
    press('ArrowDown')
    search('fix')
    expect(selectedTitle()).toBe('Session 0')
    search('')
    expect(selectedTitle()).toBe('Session 0')
  })

  it('Enter replaces the chat: an idle one at once, a busy one only after Replace', async () => {
    const workspaceId = 'repo-1::/repo'
    const store = useAppStore.getState
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({ activeWorktreeId: workspaceId })
    for (const id of ['old', 'other']) {
      store().createUnifiedTab(workspaceId, 'agent-session', {
        id,
        entityId: id,
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        agentSessionAgent: 'claude'
      })
    }
    const order = () => store().groupsByWorktree[workspaceId]?.[0]?.tabOrder
    const resumed = structuredAgentSessionTabId('new')
    const confirm = vi.fn<(options: unknown) => Promise<boolean>>()
    const here = { workspaceId, agent: 'claude' as const, dismiss: vi.fn(), confirm }
    const { press } = renderList({ resumeHere: { ...here, tabId: 'old' } })
    const settle = async () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    const pick = async (settlement: StructuredAgentLaunchSettlement, enter = press) => {
      launch.settlement = settlement
      enter('Enter')
      await settle()
    }

    press('Enter', true)
    await settle()
    expect(order()).toEqual(['old', 'other'])

    act(() => store().activateTab('old', { worktreeId: workspaceId }))
    await pick({ kind: 'failed', error: new Error('refused') })
    expect(order()).toEqual(['old', 'other'])
    expect(store().groupsByWorktree[workspaceId]?.[0]?.activeTabId).toBe('old')

    // An unknown outcome keeps both tabs; the new one carries its own badge and Retry.
    await pick({ kind: 'visibility-unknown', sessionId: 'new' })
    expect(order()).toEqual(['old', resumed, 'other'])
    act(() => store().closeUnifiedTab(resumed))

    // A chat still replying asks first: Cancel changes nothing, Replace replaces it.
    const paneKey = structuredAgentSessionPaneKey('old', 'old')
    const working = { state: 'working', prompt: '', updatedAt: 0, stateStartedAt: 0 } as const
    useAppStore.setState({
      agentStatusByPaneKey: { [paneKey]: { ...working, paneKey, stateHistory: [] } }
    })
    confirm.mockResolvedValueOnce(false)
    await pick({ kind: 'structured', sessionId: 'new' })
    expect(order()).toEqual(['old', 'other'])
    expect(here.dismiss).toHaveBeenCalledOnce()
    confirm.mockResolvedValueOnce(true)
    await pick({ kind: 'structured', sessionId: 'new' })
    expect(order()).toEqual([resumed, 'other'])

    // A chat whose host can't be seen live asks; an idle one is replaced with no prompt.
    launch.sessionId = 'new-2'
    const idle = renderList({ resumeHere: { ...here, tabId: 'other' } })
    observation.value = 'unverifiable'
    confirm.mockResolvedValueOnce(false)
    await pick({ kind: 'structured', sessionId: 'new-2' }, idle.press)
    expect(confirm).toHaveBeenCalledTimes(3)
    observation.value = 'live'
    await pick({ kind: 'structured', sessionId: 'new-2' }, idle.press)
    expect(order()).toEqual([resumed, structuredAgentSessionTabId('new-2')])
    expect(confirm).toHaveBeenCalledTimes(3)
    launch.sessionId = 'new'
  })

  it('follows the chat the host says holds the row: this one, another open one, or a closed one', async () => {
    const workspaceId = 'repo-1::/repo'
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({ activeWorktreeId: workspaceId })
    for (const id of ['old', 'other']) {
      useAppStore.getState().createUnifiedTab(workspaceId, 'agent-session', {
        id,
        entityId: id,
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        agentSessionAgent: 'claude'
      })
    }
    const order = () => useAppStore.getState().groupsByWorktree[workspaceId]?.[0]?.tabOrder
    const dismiss = vi.fn()
    const { press } = renderList({
      resumeHere: { tabId: 'old', workspaceId, agent: 'claude', dismiss, confirm: vi.fn() }
    })
    // A row listed before the takeover carries no link; only the host's refusal names the owner.
    const refusedBy = async (sessionId: string) => {
      const refusal = {
        code: 'agent_session_conflict',
        details: { reason: 'conversationHeldElsewhere', owner: { sessionId, workspaceId } }
      }
      launch.settlement = {
        kind: 'failed',
        error: Object.assign(new Error('refused'), { refusal })
      }
      press('Enter')
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    await refusedBy('old')
    expect(dismiss).toHaveBeenCalledOnce()
    await refusedBy('other')
    expect(order()).toEqual(['old', 'other'])
    // The closed chat that holds the row reopens in this one's place.
    await refusedBy('held')
    expect(order()).toEqual(['held', 'other'])
    expect(toastError).not.toHaveBeenCalled()
    launch.settlement = { kind: 'structured', sessionId: 'new' }
  })
})
