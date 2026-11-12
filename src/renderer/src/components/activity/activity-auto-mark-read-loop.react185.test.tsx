import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
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
  useAppStore.setState({ ...initialState, refreshGitHubForWorktreeIfStale: () => {} }, true)
})

afterEach(() => {
  act(() => root?.unmount())
  useAppStore.setState(initialState, true)
  document.body.replaceChildren()
})

function seedCompletedThread(stampedAt: number, lastAssistantMessage: string): void {
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    tabsByWorktree: { [worktree.id]: [tab] },
    agentStatusByPaneKey: acceptedAgentStatuses(
      Object.entries({
        [PANE_A]: {
          state: 'done',
          prompt: PROMPT,
          updatedAt: stampedAt,
          stateStartedAt: stampedAt,
          paneKey: PANE_A,
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude',
          lastAssistantMessage
        }
      })
    ),
    activeRepoId: repo.id,
    activeWorktreeId: worktree.id
  })
}

function seedThreadStampedByLocalClock(): void {
  seedCompletedThread(Date.now() - 60_000, 'finished locally')
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

describe('Activity auto mark-read loop (React #185)', () => {
  it('leaves the selected thread unread after the user marks it unread', async () => {
    seedThreadStampedByLocalClock()
    await mountActivityPage()
    await selectSeededThread()

    // Once-per-turn auto-read must preserve a later explicit mark-unread on the still-selected thread.
    await act(async () => {
      useAppStore.getState().unacknowledgeAgents([PANE_A])
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_A]).toBeUndefined()
  })
})
