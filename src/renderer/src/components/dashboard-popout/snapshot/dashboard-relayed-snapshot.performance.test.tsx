// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type {
  DashboardCard,
  DashboardSnapshot
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { KeyedDeadlines } from '../../../../../shared/collections/keyed-deadlines'
import { AgentKanbanBoard } from '../../dashboard/board/AgentKanbanBoard'
import type { AgentKanbanLaneCardList } from '../../dashboard/board/AgentKanbanLaneCardList'
import * as cardChanges from '../../dashboard/snapshot/dashboard-card-changes'
import type { AgentTerminalDialog } from '../../dashboard/terminal-preview/AgentTerminalDialog'
import { useDashboardSnapshot } from './useDashboardSnapshot'

const { stopTimestampUpdates } = vi.hoisted(() => ({ stopTimestampUpdates: vi.fn() }))

vi.mock('@/lib/window-activity/window-visibility-interval', () => ({
  installWindowVisibilityInterval: () => stopTimestampUpdates
}))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../../dashboard/board/AgentDashboardToolbar', () => ({
  AgentDashboardToolbar: () => null
}))
vi.mock('../../dashboard/board/AgentKanbanLaneCardList', () => ({
  AgentKanbanLaneCardList: ({
    cards,
    lane,
    onOpenTerminal
  }: ComponentProps<typeof AgentKanbanLaneCardList>) => (
    <>
      <button type="button" onClick={() => onOpenTerminal(cards[lane.indexes[0]])}>
        Open first
      </button>
      <button type="button" onClick={() => onOpenTerminal(cards[lane.indexes.at(-1)!])}>
        Open last
      </button>
    </>
  )
}))
vi.mock('../../dashboard/terminal-preview/AgentTerminalDialog', () => ({
  AgentTerminalDialog: ({ card, onOpenChange }: ComponentProps<typeof AgentTerminalDialog>) =>
    card && (
      <div role="dialog" data-state="open" data-pty={card.ptyId} data-leaf={card.leafId}>
        <span>{card.conversationName}</span>
        <button type="button" onClick={() => onOpenChange(false)}>
          Dismiss
        </button>
      </div>
    )
}))

const NOW = 2_000_000

function fleet(size: number, firstExpiryDelay = 100): DashboardSnapshot {
  return {
    generatedAt: NOW,
    cards: Array.from({ length: size }, (_, index) => ({
      paneKey: `pane-${index}`,
      ptyId: `pty-${index}`,
      leafId: `leaf-${index}`,
      tabId: `tab-${index}`,
      worktreeId: `worktree-${index}`,
      worktreeName: `Workspace ${index}`,
      repoId: 'repo',
      repoName: 'Repo',
      agentType: 'codex',
      bucket: 'working',
      dotState: 'working',
      task: '',
      startedAt: index === 0 ? 10 : 0,
      finishedAt: null,
      stateChangedAt: size - index,
      statusUpdatedAt: 200_000 + firstExpiryDelay + size - 1 - index,
      unseen: false,
      conversationName: `Agent ${index}`
    }))
  }
}

function installIpc() {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const unsubscribeSnapshot = vi.fn()
  const unsubscribeStatus = vi.fn()
  const unsubscribeClear = vi.fn()
  const onSnapshot = vi.fn((_receive: (snapshot: DashboardSnapshot) => void) => unsubscribeSnapshot)
  const onSet = vi.fn((_receive: (status: AgentStatusIpcPayload) => void) => unsubscribeStatus)
  const onClear = vi.fn(() => unsubscribeClear)
  const requestSnapshot = vi.fn(() => Promise.resolve())
  vi.stubGlobal('api', {
    dashboard: { onSnapshot, requestSnapshot },
    agentStatus: { onSet, onClear }
  })
  return {
    requestSnapshot,
    unsubscribeSnapshot,
    unsubscribeStatus,
    unsubscribeClear,
    receive: (snapshot: DashboardSnapshot) => act(() => onSnapshot.mock.calls[0][0](snapshot)),
    receiveStatus: (status: AgentStatusIpcPayload) => act(() => onSet.mock.calls[0][0](status))
  }
}

afterEach(() => {
  cleanup()
  stopTimestampUpdates.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// #46074 reinserted every deadline on every cloned frame, paying for a heap sift per active card.
it.each([100, 1000])(
  'bulk-loads relayed deadlines with %s cards and refreshes on expiry',
  (size) => {
    const ipc = installIpc()
    const incrementalUpdate = vi.spyOn(KeyedDeadlines.prototype, 'set')
    const readStatusTime = vi.fn((at: number | undefined) => at)
    const { unmount } = renderHook(useDashboardSnapshot)
    const source = fleet(size)
    const expectRequestAfter = (delay: number, previousRequests: number) => {
      vi.advanceTimersByTime(delay - 1)
      expect(ipc.requestSnapshot).toHaveBeenCalledTimes(previousRequests)
      vi.advanceTimersByTime(1)
      expect(ipc.requestSnapshot).toHaveBeenCalledTimes(previousRequests + 1)
    }
    const relay = () => {
      const frame = structuredClone(source)
      for (const card of frame.cards) {
        const at = card.statusUpdatedAt
        Object.defineProperty(card, 'statusUpdatedAt', { get: () => readStatusTime(at) })
      }
      readStatusTime.mockClear()
      ipc.receive(frame)
      expect(readStatusTime).toHaveBeenCalledTimes(size)
      expect(incrementalUpdate).not.toHaveBeenCalled()
    }
    relay()
    source.cards[0].subagents = [{ id: 'worker', name: 'Helper', dotState: 'working' }]
    relay()
    expectRequestAfter(351, 1)

    const replacement = fleet(size, 1_100)
    replacement.cards[size - 1].statusUpdatedAt = 201_100 + size
    replacement.cards.splice(size - 2, 1)
    replacement.cards.reverse()
    ipc.receive(structuredClone(replacement))
    expect(incrementalUpdate).not.toHaveBeenCalled()
    ipc.receiveStatus({
      paneKey: `pane-${size - 3}`,
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt: 3,
      state: 'working',
      prompt: ''
    })
    expect(incrementalUpdate).toHaveBeenCalledTimes(1)
    expectRequestAfter(1_003, 2)

    ipc.receive(structuredClone(replacement))
    unmount()
    expect(ipc.unsubscribeSnapshot).toHaveBeenCalledTimes(1)
    expect(ipc.unsubscribeStatus).toHaveBeenCalledTimes(1)
    expect(ipc.unsubscribeClear).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(ipc.requestSnapshot).toHaveBeenCalledTimes(3)
  }
)

function RelayedBoard() {
  return <AgentKanbanBoard snapshot={useDashboardSnapshot()} onAckAgent={() => {}} />
}

// #46074 indexed every pane and counted every timestamp on cloned frames with a first-card hit.
it.each([
  [100, 'Agent 99', 'pty-99'],
  [1000, 'Agent 999', 'pty-999']
])(
  'stops dialog and timestamp queries at the first hit with %s relayed cards',
  (size, lastName, lastPty) => {
    const ipc = installIpc()
    const locate = cardChanges.dashboardCardIndex
    let readingDialogKey = false
    vi.spyOn(cardChanges, 'dashboardCardIndex').mockImplementation((cards, key) => {
      readingDialogKey = true
      try {
        return locate(cards, key)
      } finally {
        readingDialogKey = false
      }
    })
    const readPane = vi.fn()
    const readTimestamp = vi.fn()
    const source = fleet(size)
    const relay = () => {
      const frame = structuredClone(source)
      for (const card of frame.cards) {
        const { paneKey, startedAt } = card
        Object.defineProperties(card, {
          paneKey: {
            get: () => {
              if (readingDialogKey) {
                readPane()
              }
              return paneKey
            }
          },
          startedAt: {
            get: () => {
              readTimestamp()
              return startedAt
            }
          }
        })
      }
      readPane.mockClear()
      readTimestamp.mockClear()
      ipc.receive(frame)
    }

    render(<RelayedBoard />)
    relay()
    fireEvent.click(screen.getByRole('button', { name: 'Open first' }))
    expect(screen.getByText('Agent 0')).toBeTruthy()
    for (const name of ['Helper', 'Renamed helper']) {
      source.cards[1].subagents = [{ id: 'worker', name, dotState: 'working' }]
      relay()
      expect(readPane).toHaveBeenCalledTimes(1)
      expect(readTimestamp).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('dialog').getAttribute('data-pty')).toBe('pty-0')
    }
    expect(stopTimestampUpdates).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open last' }))
    expect(screen.getByText(lastName)).toBeTruthy()
    source.cards.reverse()
    source.cards[0].conversationName = 'Moved agent'
    relay()
    expect(screen.getByText('Moved agent')).toBeTruthy()
    expect(screen.getByRole('dialog').getAttribute('data-pty')).toBe(lastPty)
    source.cards.shift()
    relay()
    expect(screen.getByText(lastName)).toBeTruthy()
    expect(screen.getByRole('dialog').getAttribute('data-pty')).toBeNull()
    expect(screen.getByRole('dialog').getAttribute('data-leaf')).toBeNull()
    expect(stopTimestampUpdates).not.toHaveBeenCalled()

    source.cards.at(-1)!.startedAt = 0
    relay()
    expect(stopTimestampUpdates).toHaveBeenCalledTimes(1)
  }
)

function countPaneLookups() {
  let readingPane = false
  let visits = 0
  const observe = (card: DashboardCard) => {
    const key = card.paneKey
    Object.defineProperty(card, 'paneKey', {
      get: () => {
        if (readingPane) {
          visits++
        }
        return key
      }
    })
  }
  const locate = cardChanges.dashboardCardIndex
  vi.spyOn(cardChanges, 'dashboardCardIndex').mockImplementation((cards, key) => {
    readingPane = true
    try {
      return locate(cards, key)
    } finally {
      readingPane = false
    }
  })
  const replace = cardChanges.replaceDashboardCards
  vi.spyOn(cardChanges, 'replaceDashboardCards').mockImplementation((cards, changes) => {
    const result = replace(cards, changes)
    // Local patches spread cards, so observe the new objects without changing array ownership.
    for (const card of changes.values()) {
      observe(card)
    }
    return result
  })
  return {
    clone: (source: DashboardSnapshot) => {
      const frame = structuredClone(source)
      frame.cards.forEach(observe)
      return frame
    },
    takeVisits: () => {
      const count = visits
      visits = 0
      return count
    }
  }
}

function firstPaneStatus(): AgentStatusIpcPayload {
  return {
    paneKey: 'pane-0',
    connectionId: null,
    receivedAt: NOW + 1,
    stateStartedAt: 1,
    state: 'working',
    prompt: '',
    subagents: [{ id: 'worker', description: 'Helper', state: 'working', startedAt: NOW }]
  }
}

// #46074 built a full pane index before rejecting the first event after a local patch.
it.each([
  [100, 98],
  [1000, 998]
])('bounds post-patch status lookups with %s relayed cards', (size, remainingCards) => {
  const ipc = installIpc()
  const lookups = countPaneLookups()
  const { result } = renderHook(useDashboardSnapshot)
  const source = fleet(size, 10_000)
  const patch = firstPaneStatus()
  const rename: AgentStatusIpcPayload = {
    ...patch,
    receivedAt: NOW + 2,
    subagents: [{ id: 'worker', description: 'Renamed helper', state: 'working', startedAt: NOW }]
  }
  const stale = { ...rename, receivedAt: patch.receivedAt }
  const wrongWorktree = { ...rename, worktreeId: 'other-worktree' }

  for (const [first, second] of [
    [stale, wrongWorktree],
    [stale, wrongWorktree],
    [wrongWorktree, stale]
  ]) {
    const frame = lookups.clone(source)
    ipc.receive(frame)
    ipc.receiveStatus(patch)
    expect(lookups.takeVisits()).toBe(1)
    const patched = result.current
    expect(patched.cards[0].subagents).toEqual([
      { id: 'pane-0\u0000subagent:worker', name: 'Helper', dotState: 'working' }
    ])
    expect(patched.cards[1]).toBe(frame.cards[1])

    ipc.receiveStatus(first)
    expect(lookups.takeVisits()).toBeLessThanOrEqual(1)
    expect(result.current).toBe(patched)
    ipc.receiveStatus(second)
    expect(lookups.takeVisits()).toBe(0)
    expect(result.current).toBe(patched)

    ipc.receiveStatus(rename)
    expect(lookups.takeVisits()).toBe(0)
    expect(result.current.cards[0].subagents?.[0].name).toBe('Renamed helper')
  }

  ipc.receiveStatus({ ...patch, paneKey: 'pane-1' })
  expect(lookups.takeVisits()).toBe(1)
  const lastPane = source.cards.at(-1)!.paneKey
  ipc.receiveStatus({ ...patch, paneKey: lastPane })
  expect(lookups.takeVisits()).toBe(remainingCards)
  expect(result.current.cards.at(-1)?.subagents?.[0].name).toBe('Helper')
  ipc.receiveStatus({ ...patch, paneKey: 'pane-2' })
  expect(lookups.takeVisits()).toBe(0)
  expect(result.current.cards[2].subagents?.[0].name).toBe('Helper')

  const [first, removed, moved, ...rest] = source.cards
  const duplicate = { ...first, worktreeId: 'duplicate-worktree' }
  ipc.receive(lookups.clone({ ...source, cards: [moved, duplicate, ...rest, first] }))
  ipc.receiveStatus({ ...patch, paneKey: moved.paneKey })
  expect(lookups.takeVisits()).toBe(1)
  ipc.receiveStatus({ ...rename, worktreeId: duplicate.worktreeId })
  expect(lookups.takeVisits()).toBe(2)
  expect(result.current.cards[1].subagents?.[0].name).toBe('Renamed helper')
  expect(result.current.cards.at(-1)?.subagents).toBeUndefined()

  const beforeMissing = result.current
  const missing = { ...patch, paneKey: removed.paneKey }
  ipc.receiveStatus(missing)
  expect(lookups.takeVisits()).toBe(remainingCards)
  ipc.receiveStatus(missing)
  expect(lookups.takeVisits()).toBe(0)
  expect(result.current).toBe(beforeMissing)

  ipc.receiveStatus({ ...patch, receivedAt: NOW + 3, worktreeId: duplicate.worktreeId })
  expect(lookups.takeVisits()).toBe(0)
  expect(result.current.cards[1].subagents?.[0].name).toBe('Helper')
  expect(result.current.cards.at(-1)?.subagents).toBeUndefined()
  vi.advanceTimersByTime(250)
  expect(ipc.requestSnapshot).toHaveBeenCalledTimes(2)
})

// #46074 could build the index in the first-card dialog as soon as a local patch was published.
it.each([100, 1000])('bounds open-dialog lookups after patches with %s relayed cards', (size) => {
  const ipc = installIpc()
  const lookups = countPaneLookups()
  const source = fleet(size)
  const patch = firstPaneStatus()
  render(<RelayedBoard />)
  ipc.receive(lookups.clone(source))
  fireEvent.click(screen.getByRole('button', { name: 'Open first' }))
  expect(lookups.takeVisits()).toBe(1)

  for (const name of ['Relayed agent', 'Renamed agent']) {
    source.cards[0].conversationName = name
    ipc.receive(lookups.clone(source))
    expect(lookups.takeVisits()).toBe(1)
    ipc.receiveStatus(patch)
    expect(lookups.takeVisits()).toBeLessThanOrEqual(2)
    expect(screen.getByText(name)).toBeTruthy()
    expect(screen.getByRole('dialog').getAttribute('data-pty')).toBe('pty-0')
    ipc.receiveStatus(patch)
    expect(lookups.takeVisits()).toBe(0)
  }
})
