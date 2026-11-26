// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { revealDashboardAgent } from '@/components/dashboard/navigation/reveal-dashboard-agent'
import { CommanderCenterView } from './CommanderCenter'
import { openCommanderChat } from './open-commander-chat'
import type { DashboardCard } from '../../../../shared/agent-status/presentation/dashboard-snapshot'

vi.mock('@/components/dashboard/navigation/reveal-dashboard-agent', () => ({
  revealDashboardAgent: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: () => undefined }))
vi.mock('./open-commander-chat', () => ({ openCommanderChat: vi.fn() }))
vi.mock('@/store/index', () => {
  const state = {
    activeOrcaProfileId: 'profile',
    orcaProfileSwitching: false,
    fetchOrcaProfileAuthStatus: vi.fn(),
    orcaProfileAuthStatus: {
      activeProfileId: 'profile',
      state: 'connected',
      cloud: { userId: 'me', activeOrgId: null }
    }
  }
  return {
    useAppStore: Object.assign((select: (store: typeof state) => unknown) => select(state), {
      getState: () => state
    })
  }
})
vi.mock('./CommanderRecording', () => ({ CommanderRecording: () => null }))
vi.mock('./CommanderPhoneSharing', () => ({ CommanderPhoneSharing: () => null }))
vi.mock('@/components/dashboard/navigation/reveal-dashboard-agent', () => ({
  revealDashboardAgent: vi.fn()
}))
vi.mock('@/components/dashboard/snapshot/useLiveDashboardSnapshot', () => ({
  useLiveDashboardSnapshot: vi.fn()
}))
vi.mock('@/components/dashboard/terminal-preview/AgentTerminalDialog', () => ({
  AgentTerminalDialog: () => null
}))

beforeEach(() => {
  vi.stubGlobal('api', {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function card(repoId: string, state: 'waiting' | 'blocked' | 'working'): DashboardCard {
  return {
    paneKey: repoId + state,
    repoId,
    repoName: repoId,
    ptyId: null,
    tabId: repoId + state,
    leafId: null,
    worktreeId: repoId,
    worktreeName: repoId,
    agentType: 'codex',
    bucket: state === 'working' ? 'working' : 'attention',
    dotState: state,
    task: state,
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: true
  }
}

it('opens a project status from the keyboard, narrows the board to that lane and restores all lanes', async () => {
  const user = userEvent.setup()
  const repos = ['api', 'web'].map((id) => ({
    id,
    displayName: id,
    upstream: { owner: 'org', repo: id }
  }))
  render(
    <CommanderCenterView
      repos={repos}
      snapshot={{
        generatedAt: 0,
        cards: [
          card('api', 'waiting'),
          card('api', 'blocked'),
          card('web', 'waiting'),
          card('web', 'working')
        ]
      }}
    />
  )
  const waiting = screen.getByRole('button', { name: 'org/api · Waiting · 1' })
  waiting.focus()
  await user.keyboard('{Enter}')
  expect(waiting).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('region', { name: 'Working' })).not.toBeInTheDocument()
  expect(
    within(screen.getByRole('region', { name: 'Needs You' })).getByText('1')
  ).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'org/api · Working · 0' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'org/web · Working · 1' }))
  expect(screen.getByRole('region', { name: 'Working' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Needs You' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'org/web · Total · 2' }))
  expect(screen.getByRole('region', { name: 'Needs You' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Working' })).toBeInTheDocument()
})

it('opens chat on demand and leaves a failed launch available to retry', async () => {
  const user = userEvent.setup()
  const launch = vi.mocked(openCommanderChat)
  launch.mockRejectedValueOnce(new Error('Provider setup required')).mockResolvedValueOnce(true)
  render(<CommanderCenterView repos={[]} snapshot={{ generatedAt: 0, cards: [] }} />)
  expect(launch).not.toHaveBeenCalled()
  const talk = screen.getByRole('button', { name: 'Talk to Commander' })
  await user.click(talk)
  expect(await screen.findByRole('alert')).toHaveTextContent('Provider setup required')
  await user.click(talk)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(talk).toBeEnabled()
})

it('keeps an unsaved handoff when moving between Commander tabs', async () => {
  const user = userEvent.setup()
  const save = vi.fn()
  vi.stubGlobal('api', {
    commanderMemory: {
      list: vi.fn().mockResolvedValue({ pages: [] }),
      index: async () => ({ pages: [], projects: [], next: null }),
      save
    }
  })
  render(<CommanderCenterView repos={[]} snapshot={{ generatedAt: 0, cards: [] }} />)
  const handoffs = screen.getByRole('tab', { name: 'Handoffs' })
  await user.click(handoffs)
  await user.click(await screen.findByRole('button', { name: 'New handoff' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), {
    target: { value: 'Keep my unsaved goal' }
  })
  await user.click(screen.getByRole('tab', { name: 'Memory' }))
  expect(screen.queryByRole('textbox', { name: 'Goal' })).not.toBeInTheDocument()
  await user.click(handoffs)
  expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue('Keep my unsaved goal')
  expect(save).not.toHaveBeenCalled()
})

it('opens the selected source of a repeated decision on its own host and removes settled requests', async () => {
  const a: DashboardCard = {
    ...card('api', 'blocked'),
    askSummary: 'Choose a release target',
    executionHostId: 'local',
    worktreeName: 'api-release'
  }
  const b: DashboardCard = {
    ...card('web', 'blocked'),
    askSummary: 'Choose a release target',
    executionHostId: 'runtime:staging',
    worktreeName: 'web-release'
  }
  const { rerender } = render(
    <CommanderCenterView repos={[]} snapshot={{ generatedAt: 0, cards: [a, b] }} />
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: 'Decisions' }))
  await user.click(screen.getByText('Choose a release target'))
  expect(screen.getByText('Requests: 2')).toBeInTheDocument()
  vi.mocked(revealDashboardAgent).mockReturnValueOnce(true)
  await user.click(screen.getByRole('button', { name: /web-release/ }))
  expect(revealDashboardAgent).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: 'web', executionHostId: 'runtime:staging' })
  )
  rerender(
    <CommanderCenterView
      repos={[]}
      snapshot={{ generatedAt: 1, cards: [a, { ...b, bucket: 'working', dotState: 'working' }] }}
    />
  )
  expect(screen.getByText('Requests: 1')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /web-release/ })).not.toBeInTheDocument()
})
