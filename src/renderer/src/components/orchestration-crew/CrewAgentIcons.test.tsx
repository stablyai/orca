// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from '../native-chat/native-chat-tooltip-test-harness'
import {
  initialStore,
  LEAF,
  status,
  resetSenderStore
} from '../native-chat/native-chat-agent-sender.test-fixture'
import { CrewAgentIcons, useCrewRowLooks } from './CrewAgentIcons'
import { CrewPanelContent } from './OrchestrationCrewPanel'
import { useAppStore } from '@/store'
import { makeTab, makeUnifiedTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import * as presentation from '@/lib/program-status/agent-row-presentation'
import * as worktreeStatus from '@/lib/worktree-status'
import * as sessionTime from '@/components/right-sidebar/ai-vault-session-time'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { emptyCrew } from '../../../../shared/orchestration-crew'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

const local = { kind: 'local' } as const
function row(id = 0): OrchestrationCrewRow {
  return {
    partyKey: `party-${id}`,
    role: 'worker',
    label: `Worker ${id}`,
    agentKind: 'codex',
    status: 'done',
    openTarget: { kind: 'terminal', handle: `term_${id}` },
    sendAddress: `dispatch:worker-${id}`,
    task: { title: `Keep task ${id}`, state: 'active' },
    latest: {
      direction: 'from',
      preview: 'Reported',
      at: new Date(1_000_000).toISOString(),
      sequence: id
    }
  }
}
function panel(rows: OrchestrationCrewRow[], target: RuntimeClientTarget = local) {
  return (
    <CrewPanelContent
      target={target}
      party="term_owner"
      canMention={false}
      mention={vi.fn()}
      snapshot={{
        ...emptyCrew('ok'),
        sections: { managedBy: [], managing: rows, talkingWith: [] }
      }}
    />
  )
}
function Looks({ rows }: { rows: OrchestrationCrewRow[] }) {
  const looks = useCrewRowLooks(rows, local)
  return (
    <>
      {rows.map((value, index) => (
        <div key={value.partyKey} data-testid={value.partyKey}>
          <CrewAgentIcons look={looks[index]} hostLabel={value.hostLabel} />
        </div>
      ))}
    </>
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

it('groups the closed tab and shows the row by the live terminal state, with a question first', () => {
  const mounted = render(panel([row()]))
  const tab = screen.getByRole('button', { name: 'Show orchestration: 1 worker, 1 working' })
  fireEvent.click(tab)
  const body = screen.getByRole('button', { name: /^Mention Worker 0:/ })
  expect(within(body).getByRole('img', { name: 'Working' })).toBeInTheDocument()
  expect(within(body).queryByRole('img', { name: 'Done' })).toBeNull()
  expect(within(body).getByRole('img', { name: 'Claude' })).toBeInTheDocument()
  mounted.rerender(panel([{ ...row(), pendingQuestion: { at: 'now', preview: 'Choose' } }]))
  expect(within(body).getByRole('img', { name: 'Needs permission' })).toBeInTheDocument()
  expect(within(body).queryByRole('img', { name: 'Working' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse orchestration panel' }))
  expect(
    screen.getByRole('button', { name: 'Show orchestration: 1 worker, 1 needs you' })
  ).toBeInTheDocument()
})

it('resolves the actual session before a conflicting terminal', () => {
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
  const rows = [
    { ...row(), openTarget: { kind: 'chat' as const, sessionId, worktreeId: 'workspace' } }
  ]
  render(<Looks rows={rows} />)
  expect(screen.getByRole('img', { name: 'Needs permission' })).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: 'Working' })).toBeNull()
})

it('follows a terminal into retained state and falls back only after its local pane disappears', () => {
  render(<Looks rows={[{ ...row(), status: 'waiting' }]} />)
  expect(screen.getByRole('img', { name: 'Working' })).toBeInTheDocument()
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
  expect(screen.getByRole('img', { name: 'Done' })).toBeInTheDocument()
  act(() => useAppStore.setState({ retainedAgentsByPaneKey: {} }))
  expect(screen.getByRole('img', { name: 'Needs permission' })).toBeInTheDocument()
})

it('keeps imported, missing, dispatch and failed-task peers on the Crew snapshot despite matching local handles', () => {
  const base = row()
  const rows = [
    { ...base, partyKey: 'imported', hostLabel: 'Other host' },
    { ...base, partyKey: 'missing', openTarget: undefined, status: 'unknown' },
    {
      ...base,
      partyKey: 'dispatch',
      openTarget: { kind: 'dispatch' as const, address: 'dispatch:worker-0' }
    },
    { ...base, partyKey: 'failed', hostLabel: 'Other host', task: { title: 'x', state: 'failed' } }
  ]
  render(<Looks rows={rows} />)
  for (const id of ['imported', 'dispatch']) {
    expect(within(screen.getByTestId(id)).getByRole('img', { name: 'Done' })).toBeInTheDocument()
  }
  expect(
    within(screen.getByTestId('missing')).getByRole('img', { name: 'Inactive' })
  ).toBeInTheDocument()
  expect(
    within(screen.getByTestId('failed')).getByRole('img', { name: 'Failed' })
  ).toBeInTheDocument()
  expect(screen.getAllByRole('img', { name: 'Codex · Other host' })).toHaveLength(2)
})

it.each([10, 100])(
  'resolves %i Crew rows under one store subscription and re-renders only the changed row',
  async (n) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(2_000_000)
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
    const labels = vi.spyOn(worktreeStatus, 'getWorktreeStatusLabel')
    const listeners = readStoreListenerCount()
    const mounted = render(panel(Array.from({ length: n }, (_, i) => row(i))))
    await act(async () => {})
    expect(readStoreListenerCount()).toBe((listeners ?? 0) + 1)
    fireEvent.click(screen.getByRole('button', { name: /^Show orchestration:/ }))
    expect(normalize).toHaveBeenCalledTimes(n)
    visits = 0
    normalize.mockClear()
    labels.mockClear()
    act(() => useAppStore.setState({ sidebarBody: 'agents' }))
    expect(visits).toBe(0)
    expect(normalize).not.toHaveBeenCalled()
    expect(labels).not.toHaveBeenCalled()
    // Another host's pane shares no row, so no row renders.
    act(() =>
      useAppStore.getState().setAgentProgramStatus(other.paneKey, {
        state: 'working',
        progress: 20,
        observedAt: 2_000_000
      })
    )
    expect(labels).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState((state) => ({
        agentStatusByPaneKey: {
          ...state.agentStatusByPaneKey,
          [status(0).paneKey]: { ...status(0), state: 'done' }
        }
      }))
    )
    expect(labels).toHaveBeenCalled()
    expect(new Set(labels.mock.calls.map(([value]) => value))).toEqual(new Set(['done']))
    expect(screen.getAllByRole('img', { name: 'Done' })).toHaveLength(1)
    // One shared 30s tick re-renders only the time labels, not the rows.
    const ages = vi.spyOn(sessionTime, 'formatTimeAgo')
    labels.mockClear()
    expect(screen.getAllByText('16m ago')).toHaveLength(n)
    act(() => vi.advanceTimersByTime(30_000))
    expect(ages).toHaveBeenCalledTimes(n)
    expect(labels).not.toHaveBeenCalled()
    expect(screen.getAllByText('17m ago')).toHaveLength(n)
    mounted.unmount()
    expect(readStoreListenerCount()).toBe(listeners)
  }
)
