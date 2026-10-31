// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from '../native-chat/native-chat-tooltip-test-harness'
import {
  initialStore,
  LEAF,
  status,
  resetSenderStore
} from '../native-chat/native-chat-agent-sender.test-fixture'
import { AgentMessageAvatar } from '../AgentMessageAvatar'
import { CrewAgentAvatar } from './CrewAgentAvatar'
import { CrewPanelContent } from './OrchestrationCrewPanel'
import { useAppStore } from '@/store'
import { makeTab, makeUnifiedTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import * as presentation from '@/lib/program-status/agent-row-presentation'
import * as selectors from '@/components/sidebar/worktree-agent-row-selectors'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { emptyCrew } from '../../../../shared/orchestration-crew'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

const local = { kind: 'local' } as const
const remote = { kind: 'environment', environmentId: 'remote' } as const
function row(id = 0): OrchestrationCrewRow {
  return {
    partyKey: `party-${id}`,
    role: 'worker',
    label: `Worker ${id}`,
    agentKind: 'codex',
    status: 'done',
    openTarget: { kind: 'terminal', handle: `term_${id}` },
    sendAddress: `dispatch:worker-${id}`,
    task: { title: 'Keep task', state: 'active' }
  }
}
function panel(worker: OrchestrationCrewRow) {
  return (
    <CrewPanelContent
      target={local}
      party="term_owner"
      snapshot={{
        ...emptyCrew('ok'),
        sections: { managedBy: [], managing: [worker], talkingWith: [] }
      }}
    />
  )
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  resetSenderStore()
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('uses the card avatar live terminal state in the collapsed stack and expanded row with its existing tooltip', async () => {
  const user = userEvent.setup()
  const mounted = render(panel(row()))
  const tab = screen.getByRole('button', { name: 'Show crew: 1 workers' })
  expect(within(tab).getByLabelText('Working')).toBeInTheDocument()
  expect(within(tab).queryByLabelText('Done')).toBeNull()
  fireEvent.click(tab)
  const body = screen.getByRole('button', { name: /Worker 0 Keep task/ })
  expect(within(body).getByLabelText('Working')).toBeInTheDocument()
  expect(screen.queryByText('claude')).toBeNull()
  await user.hover(screen.getByRole('img', { name: 'Claude' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Claude')
  act(() =>
    useAppStore.getState().setAgentProgramStatus(status(0).paneKey, {
      state: 'working',
      progress: 80,
      observedAt: 2_000_000
    })
  )
  expect(within(body).getByRole('progressbar')).toBeInTheDocument()
  mounted.rerender(panel({ ...row(), pendingQuestion: { at: 'now', preview: 'Choose' } }))
  expect(within(body).getByLabelText('Needs attention')).toBeInTheDocument()
  expect(within(body).queryByLabelText('Working')).toBeNull()
  expect(within(body).queryByRole('progressbar')).toBeNull()
  expect(screen.getByText(/Waiting for you/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse crew panel' }))
  expect(
    within(screen.getByRole('button', { name: 'Show crew: 1 workers' })).getByLabelText(
      'Needs attention'
    )
  ).toBeInTheDocument()
})

it('resolves the actual session before a conflicting terminal and shares its glyph with a card avatar', () => {
  const sessionId = testOrcaSessionId('crew-chat')
  const tab = makeUnifiedTab({
    id: 'chat-tab',
    entityId: sessionId,
    worktreeId: 'workspace',
    groupId: 'g',
    contentType: 'agent-session',
    executionHostId: 'local',
    agentSessionAgent: 'claude'
  })
  const paneKey = structuredAgentSessionPaneKey(tab.id, sessionId)
  useAppStore.setState({
    unifiedTabsByWorktree: { workspace: [tab] },
    agentStatusByPaneKey: {
      [status(0).paneKey]: status(0),
      [paneKey]: { ...status(1), paneKey, state: 'waiting' }
    }
  })
  const worker = {
    ...row(),
    openTarget: { kind: 'chat' as const, sessionId, worktreeId: 'workspace' }
  }
  render(
    <>
      <div data-testid="crew">
        <CrewAgentAvatar row={worker} target={local} />
      </div>
      <div data-testid="card">
        <AgentMessageAvatar
          sender={{
            name: worker.label,
            party: {
              address: `orca_session_id:${sessionId}`,
              orcaSessionId: sessionId,
              terminalHandle: 'term_0'
            }
          }}
          worktreeId="workspace"
          target={local}
        />
      </div>
    </>
  )
  const crew = within(screen.getByTestId('crew')).getByLabelText('Waiting for input')
  const card = within(screen.getByTestId('card')).getByLabelText('Waiting for input')
  expect(crew.innerHTML).toBe(card.innerHTML)
  expect(screen.queryByLabelText('Working')).toBeNull()
})

it('follows a terminal into retained state and falls back only after its local pane disappears', () => {
  const worker = { ...row(), status: 'waiting' }
  render(<CrewAgentAvatar row={worker} target={local} />)
  expect(screen.getByLabelText('Working')).toBeInTheDocument()
  const entry = { ...status(0), state: 'done' as const }
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {
        [entry.paneKey]: {
          entry,
          tab: makeTab({ id: 'tab-0', worktreeId: 'workspace' }),
          worktreeId: 'workspace',
          agentType: 'claude',
          startedAt: 1
        }
      }
    })
  )
  expect(screen.getByLabelText('Done')).toBeInTheDocument()
  act(() => useAppStore.setState({ retainedAgentsByPaneKey: {} }))
  expect(screen.getByLabelText('Needs attention')).toBeInTheDocument()
})

it('keeps imported, missing, dispatch and other-host peers on Crew fallback despite matching local handles', () => {
  const base = row()
  render(
    <>
      <div data-testid="imported">
        <CrewAgentAvatar row={{ ...base, hostLabel: 'Other host' }} target={local} tooltip />
      </div>
      <div data-testid="missing">
        <CrewAgentAvatar
          row={{ ...base, openTarget: undefined, status: 'unknown' }}
          target={local}
        />
      </div>
      <div data-testid="dispatch">
        <CrewAgentAvatar
          row={{ ...base, openTarget: { kind: 'dispatch', address: 'dispatch:worker-0' } }}
          target={local}
        />
      </div>
      <div data-testid="remote">
        <CrewAgentAvatar row={base} target={remote} />
      </div>
    </>
  )
  for (const id of ['imported', 'dispatch', 'remote']) {
    expect(within(screen.getByTestId(id)).getByLabelText('Done')).toBeInTheDocument()
    expect(within(screen.getByTestId(id)).queryByLabelText('Working')).toBeNull()
  }
  expect(within(screen.getByTestId('missing')).getByLabelText('Idle')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'Codex · Other host' })).toBeInTheDocument()
})

it.each([10, 100])(
  'shares real sender projection for %i Crew avatars and isolates committed row updates',
  async (n) => {
    let visits = 0
    const other = status(n, 'remote')
    const entries = Object.fromEntries(
      [...Array.from({ length: n }, (_, i) => status(i)), other].map((entry) => [
        entry.paneKey,
        entry
      ])
    )
    const live = new Proxy(entries, {
      ownKeys(target) {
        const keys = Object.getOwnPropertyNames(target)
        visits += keys.length
        return keys
      }
    })
    useAppStore.setState({
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({ id: 'remote', repoId: TEST_REPO.id, hostId: 'runtime:remote' })
        ]
      },
      tabsByWorktree: {
        workspace: Array.from({ length: n }, (_, i) =>
          makeTab({ id: `tab-${i}`, worktreeId: 'workspace' })
        ),
        remote: [makeTab({ id: `tab-${n}`, worktreeId: 'remote' })]
      },
      terminalLayoutsByTabId: Object.fromEntries(
        Array.from({ length: n + 1 }, (_, i): [string, TerminalLayoutSnapshot] => [
          `tab-${i}`,
          { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
        ])
      ),
      agentStatusByPaneKey: live
    })
    const normalize = vi.spyOn(presentation, 'resolveRowProgramStatus')
    const selectLive = vi.spyOn(selectors, 'selectLiveAgentStatusEntriesForWorktree')
    const values = Object.values
    const enumerations = new Map<object, number[]>()
    const observeValues = vi.spyOn(Object, 'values').mockImplementation((source) => {
      const result = values(source)
      if (typeof source === 'object' && source !== null) {
        const lengths = enumerations.get(source) ?? []
        lengths.push(result.length)
        enumerations.set(source, lengths)
      }
      return result
    })
    const commits = new Map<number, number>()
    const listeners = readStoreListenerCount()
    const mounted = render(
      <>
        {Array.from({ length: n + 1 }, (_, id) => (
          <Profiler
            key={id}
            id={String(id)}
            onRender={() => commits.set(id, (commits.get(id) ?? 0) + 1)}
          >
            <div data-testid={`avatar-${id}`}>
              <CrewAgentAvatar row={row(id)} target={id === n ? remote : local} />
            </div>
          </Profiler>
        ))}
      </>
    )
    await act(async () => {})
    expect(visits).toBe((n + 1) * 3)
    expect(normalize).toHaveBeenCalledTimes(n + 1)
    const before = new Map(commits)
    visits = 0
    normalize.mockClear()
    act(() => useAppStore.setState({ sidebarBody: 'agents' }))
    expect(commits).toEqual(before)
    expect(visits).toBe(0)
    expect(normalize).not.toHaveBeenCalled()
    selectLive.mockClear()
    act(() =>
      useAppStore.getState().setAgentProgramStatus(other.paneKey, {
        state: 'working',
        progress: 20,
        observedAt: 2_000_000
      })
    )
    const remoteMap = useAppStore.getState().agentStatusByPaneKey
    expect(Object.is(remoteMap, live)).toBe(false)
    // The handle index and visible-orchestration projection each scan a fresh map once.
    expect(enumerations.get(remoteMap)).toEqual([n + 1, n + 1])
    expect(
      selectLive.mock.calls.filter(([state]) => state.agentStatusByPaneKey === remoteMap)
    ).toHaveLength(2)
    expect(
      within(screen.getByTestId(`avatar-${n}`)).getByRole('progressbar', { name: 'Working · 20%' })
    ).toBeInTheDocument()
    expect(normalize).toHaveBeenCalledTimes(1)
    for (let i = 0; i < n; i++) {
      expect(commits.get(i)).toBe(before.get(i))
    }
    expect(commits.get(n)).toBe(before.get(n)! + 1)
    // The writer copies the map; the shared live index counts its previous keys once.
    expect(visits).toBe((n + 1) * 2)
    const afterRemote = new Map(commits)
    normalize.mockClear()
    selectLive.mockClear()
    act(() =>
      useAppStore.getState().setAgentProgramStatus(status(0).paneKey, {
        state: 'working',
        progress: 40,
        observedAt: 2_000_000
      })
    )
    const localMap = useAppStore.getState().agentStatusByPaneKey
    expect(Object.is(localMap, remoteMap)).toBe(false)
    expect(enumerations.get(localMap)).toEqual([n + 1, n + 1])
    expect(enumerations.get(remoteMap)).toEqual([n + 1, n + 1])
    expect(
      selectLive.mock.calls.filter(([state]) => state.agentStatusByPaneKey === localMap)
    ).toHaveLength(2)
    expect(normalize).toHaveBeenCalledTimes(n)
    expect(commits.get(0)).toBe(afterRemote.get(0)! + 1)
    for (let i = 1; i <= n; i++) {
      expect(commits.get(i)).toBe(afterRemote.get(i))
    }
    expect(
      within(screen.getByTestId('avatar-0')).getByRole('progressbar', { name: 'Working · 40%' })
    ).toBeInTheDocument()
    expect(visits).toBe((n + 1) * 2)
    normalize.mockClear()
    const settled = new Map(commits)
    selectLive.mockClear()
    act(() =>
      useAppStore.getState().setAgentProgramStatus(status(0).paneKey, {
        state: 'working',
        progress: 40,
        observedAt: 2_000_000
      })
    )
    expect(commits).toEqual(settled)
    expect(normalize).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentStatusByPaneKey).toBe(localMap)
    expect(enumerations.get(localMap)).toEqual([n + 1, n + 1])
    expect(selectLive).not.toHaveBeenCalled()
    mounted.unmount()
    expect(readStoreListenerCount()).toBe(listeners)
    observeValues.mockRestore()
    selectLive.mockRestore()
  }
)
