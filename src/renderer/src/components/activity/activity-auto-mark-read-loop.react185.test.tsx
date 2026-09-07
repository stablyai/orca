/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import ActivityPrototypePage from './ActivityPrototypePage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const TAB_A = 'tab-a'
const PANE_A = makePaneKey(TAB_A, LEAF_A)
const PROMPT = 'turn stamped by the execution host'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/repo/wt-1',
  head: 'abc123',
  branch: 'feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

const tab: TerminalTab = {
  id: TAB_A,
  ptyId: 'pty-a',
  worktreeId: worktree.id,
  title: 'Claude',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

const initialState = useAppStore.getInitialState()
let root: Root
let seededContainer: HTMLElement

beforeEach(() => {
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  act(() => root?.unmount())
  useAppStore.setState(initialState, true)
  document.body.replaceChildren()
})

function seedRetainedThread(stampedAt: number, lastAssistantMessage: string): void {
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    tabsByWorktree: { [worktree.id]: [] },
    retainedAgentsByPaneKey: {
      [PANE_A]: {
        entry: {
          state: 'done',
          prompt: PROMPT,
          updatedAt: stampedAt,
          stateStartedAt: stampedAt,
          paneKey: PANE_A,
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude',
          lastAssistantMessage
        },
        worktreeId: worktree.id,
        tab,
        agentType: 'claude',
        startedAt: stampedAt
      }
    },
    activeRepoId: repo.id,
    activeWorktreeId: worktree.id
  })
}

function seedThreadStampedByLocalClock(): void {
  seedRetainedThread(Date.now() - 60_000, 'finished locally')
}

// Why: an SSH/remote execution host stamps the turn with its own clock, so the renderer can
// acknowledge a thread whose event still sorts as newer than the acknowledgement.
function seedThreadStampedAheadOfLocalClock(): void {
  seedRetainedThread(Date.now() + 60_000, 'finished on the execution host')
}

async function mountActivityPage(): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ActivityPrototypePage />
      </TooltipProvider>
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  seededContainer = container
}

async function selectSeededThread(): Promise<void> {
  const row = Array.from(seededContainer.querySelectorAll<HTMLElement>('[role="listitem"]')).find(
    (element) => element.textContent?.includes(PROMPT)
  )
  expect(row).toBeDefined()
  await act(async () => {
    row?.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

function countAcknowledgeWrites(): { readonly count: () => number; stop: () => void } {
  let writes = 0
  const unsubscribe = useAppStore.subscribe((next, prev) => {
    if (next.acknowledgedAgentsByPaneKey !== prev.acknowledgedAgentsByPaneKey) {
      writes += 1
    }
  })
  return { count: () => writes, stop: unsubscribe }
}

describe('Activity auto mark-read loop (React #185)', () => {
  it('acknowledges a selected thread once even when its unread flag cannot clear', async () => {
    seedThreadStampedAheadOfLocalClock()
    await mountActivityPage()
    const acknowledgeWrites = countAcknowledgeWrites()

    try {
      await selectSeededThread()
    } finally {
      acknowledgeWrites.stop()
    }

    expect(acknowledgeWrites.count()).toBe(1)
  })

  it('re-acknowledges when a new turn lands on the still-selected thread', async () => {
    seedThreadStampedAheadOfLocalClock()
    await mountActivityPage()
    const acknowledgeWrites = countAcknowledgeWrites()

    try {
      await selectSeededThread()
      expect(acknowledgeWrites.count()).toBe(1)

      // Why: the per-turn guard must not swallow the next turn's auto mark-read.
      const nextTurnAt = Date.now() + 120_000
      await act(async () => {
        useAppStore.setState((s) => {
          const previous = s.retainedAgentsByPaneKey[PANE_A]
          return {
            retainedAgentsByPaneKey: {
              [PANE_A]: {
                ...previous,
                startedAt: nextTurnAt,
                entry: {
                  ...previous.entry,
                  updatedAt: nextTurnAt,
                  stateStartedAt: nextTurnAt,
                  lastAssistantMessage: 'second turn on the execution host'
                }
              }
            }
          }
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
    } finally {
      acknowledgeWrites.stop()
    }

    expect(acknowledgeWrites.count()).toBe(2)
  })

  it('still marks a locally stamped thread read on selection', async () => {
    seedThreadStampedByLocalClock()
    await mountActivityPage()
    await selectSeededThread()

    expect(useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_A]).toBeGreaterThan(0)
  })

  it('leaves the selected thread unread after the user marks it unread', async () => {
    seedThreadStampedByLocalClock()
    await mountActivityPage()
    await selectSeededThread()

    // Why pinned: auto mark-read is once per turn, so an explicit mark-unread on the
    // still-selected thread must survive — a guard keyed on unread instead of the turn
    // would silently re-acknowledge it and make the menu action a no-op.
    await act(async () => {
      useAppStore.getState().unacknowledgeAgents([PANE_A])
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_A]).toBeUndefined()
  })
})
