// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openWorker: vi.fn(),
  revealPane: vi.fn(),
  openSession: vi.fn(),
  openAutomation: vi.fn(),
  openHistory: vi.fn()
}))
vi.mock('@/lib/open-orchestration-worker', () => ({
  openOrchestrationWorker: mocks.openWorker,
  revealWorkerPane: mocks.revealPane
}))
vi.mock('./bot-session-open', () => ({ openBotSession: mocks.openSession }))
vi.mock('./bot-automation-open', () => ({ openBotAutomation: mocks.openAutomation }))
vi.mock('../right-sidebar/ai-vault/panel/agent-session-history-modal', () => ({
  openAgentSessionHistoryModal: mocks.openHistory
}))
vi.mock('@/store', () => ({ useAppStore: () => null }))

import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../shared/bot-types'
import type { BotSessionActivityRow } from '../../../../shared/bots/bot-activity-model'
import type { OrchestrationSessionWorker } from '../../../../shared/orchestration-session-workers'
import { BotRecentSection } from './BotWorkingRecentSections'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the section reads only these fields.
const BOT = {
  id: 'bot-1',
  hostId: 'local',
  name: 'Dev Ops',
  chatSessionId: 'chat-1',
  folderWorkspaceId: 'f1'
} as Bot

const RECORDED: OrchestrationSessionWorker = {
  dispatchId: 'ctx_done',
  taskId: 'task_1',
  runId: 'run_1',
  title: 'PR 38365: still needed?',
  agent: 'claude',
  state: 'completed',
  liveness: 'unverifiable',
  host: 'local',
  // Its workspace was removed after it finished, as in the report.
  worktreeId: 'repo::/gone/pr-38365-e2e',
  paneKey: 'tab:leaf',
  chatSessionId: null,
  startedAt: 1_000,
  settledAt: 68_000,
  summary: 'Recommend closing'
}

function worker(overrides: Partial<Extract<BotSessionActivityRow, { kind: 'worker' }>>) {
  return {
    kind: 'worker' as const,
    key: `worker:${overrides.dispatchId ?? 'x'}`,
    dispatchId: '',
    title: 'Worker',
    dot: 'done' as const,
    origin: { kind: 'chat' as const },
    paneKey: null,
    workspaceId: null,
    at: 1,
    worker: null,
    ...overrides
  }
}

function recent(...rows: BotSessionActivityRow[]): void {
  render(
    <TooltipProvider>
      <BotRecentSection bot={BOT} completed={rows} />
    </TooltipProvider>
  )
}

function click(name: RegExp): void {
  const row = screen.getByRole('button', { name })
  expect(row).toBeEnabled()
  fireEvent.click(row)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BotRecentSection rows open what they name', () => {
  it('opens finished workers by Dispatch with or without a host record', () => {
    recent(
      worker({
        dispatchId: 'ctx_done',
        title: RECORDED.title,
        workspaceId: RECORDED.worktreeId,
        worker: RECORDED
      }),
      worker({ dispatchId: 'ctx_old', title: 'Older worker', workspaceId: 'wt-1' })
    )

    click(/PR 38365/)
    expect(mocks.openWorker).toHaveBeenCalledExactlyOnceWith(RECORDED, { kind: 'local' })

    mocks.openWorker.mockClear()
    click(/Older worker/)
    expect(mocks.openWorker).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ dispatchId: 'ctx_old', worktreeId: 'wt-1', chatSessionId: null }),
      { kind: 'local' }
    )
  })

  it('an agent in a handed workspace reveals its pane', () => {
    recent(
      worker({
        title: 'Handed agent',
        workspaceId: 'wt-handed',
        paneKey: 'tab:leaf',
        hostId: 'runtime:mini'
      })
    )
    click(/Handed agent/)
    expect(mocks.revealPane).toHaveBeenCalledExactlyOnceWith(
      'wt-handed',
      'tab:leaf',
      'runtime:mini'
    )
  })

  it('opens each automation or connector chat from its own row', () => {
    recent(
      {
        kind: 'run',
        key: 'run:r1',
        automationId: 'a1',
        automationName: 'Tidy memory',
        runId: 'r1',
        status: 'completed',
        sessionId: 'run-chat',
        dot: 'done',
        at: 1
      },
      {
        kind: 'thread',
        key: 'thread:t1',
        title: 'Deploy question',
        source: 'slack',
        dot: 'done',
        sessionId: 'thread-chat',
        at: 1
      }
    )

    click(/Tidy memory/)
    expect(mocks.openSession).toHaveBeenCalledExactlyOnceWith(BOT, 'run-chat')

    mocks.openSession.mockClear()
    click(/Deploy question/)
    expect(mocks.openSession).toHaveBeenCalledExactlyOnceWith(BOT, 'thread-chat')
  })

  it('a run in a terminal opens the run on the Automations page', () => {
    recent({
      kind: 'run',
      key: 'run:r2',
      automationId: 'a2',
      automationName: 'Look around',
      runId: 'r2',
      status: 'dispatch_failed',
      sessionId: null,
      dot: null,
      at: 1
    })
    click(/Look around/)
    expect(mocks.openAutomation).toHaveBeenCalledExactlyOnceWith('a2', 'r2')
  })
})
