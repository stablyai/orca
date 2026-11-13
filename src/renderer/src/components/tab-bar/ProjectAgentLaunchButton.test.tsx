// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProjectAgentLaunchButton } from './ProjectAgentLaunchButton'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Project } from '../../../../shared/project-types'

const boundary = vi.hoisted(() => ({
  launch: vi.fn((..._args: unknown[]) => true),
  activate: vi.fn(() => true)
}))
vi.mock('./QuickLaunchButton', () => ({
  useTabAgentMenuLaunch:
    (target: unknown) =>
    (...args: unknown[]) =>
      boundary.launch(target, ...args)
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: boundary.activate
}))
const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

it('shares the project choice across branches while retaining each clicked workspace and host', async () => {
  const projects: Project[] = [
    {
      id: 'project-a',
      displayName: 'A',
      badgeColor: '',
      sourceRepoIds: ['repo-a'],
      createdAt: 0,
      updatedAt: 0,
      agentLaunchDefault: {
        agent: 'codex',
        surface: 'chat',
        choices: { model: 'codex-project-model', options: { effort: 'high' } }
      }
    },
    {
      id: 'project-b',
      displayName: 'B',
      badgeColor: '',
      sourceRepoIds: ['repo-b'],
      createdAt: 0,
      updatedAt: 0,
      agentLaunchDefault: { agent: 'claude', surface: 'terminal', choices: {} }
    }
  ]
  useAppStore.setState(
    {
      ...initial,
      projects,
      activeWorktreeId: 'other-workspace',
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: {
        'repo-a': [
          makeWorktree({
            id: 'branch-a',
            repoId: 'repo-a',
            projectId: 'project-a',
            hostId: 'local'
          }),
          makeWorktree({
            id: 'branch-b',
            repoId: 'repo-a',
            projectId: 'project-a',
            hostId: 'runtime:server'
          })
        ],
        'repo-b': [
          makeWorktree({
            id: 'branch-c',
            repoId: 'repo-b',
            projectId: 'project-b',
            hostId: 'local'
          })
        ]
      }
    },
    true
  )
  const view = render(
    <TooltipProvider>
      <ProjectAgentLaunchButton worktreeId="branch-a" executionHostId="local" />
      <ProjectAgentLaunchButton worktreeId="branch-b" executionHostId="runtime:server" />
      <ProjectAgentLaunchButton worktreeId="branch-c" executionHostId="local" />
    </TooltipProvider>
  )
  const buttons = view.getAllByRole('button')
  fireEvent.click(buttons[0])
  fireEvent.click(buttons[1])
  fireEvent.click(buttons[2])
  await waitFor(() =>
    expect(boundary.launch).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'branch-a' }),
      { agent: 'codex', kind: 'chat', executionHostId: 'local' },
      {
        agent: 'codex',
        surface: 'chat',
        choices: { model: 'codex-project-model', options: { effort: 'high' } }
      }
    )
  )
  expect(boundary.launch).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: 'branch-b' }),
    { agent: 'codex', kind: 'chat', executionHostId: 'runtime:server' },
    {
      agent: 'codex',
      surface: 'chat',
      choices: { model: 'codex-project-model', options: { effort: 'high' } }
    }
  )
  expect(boundary.launch).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: 'branch-c' }),
    { agent: 'claude', kind: 'cli', executionHostId: 'local' },
    { agent: 'claude', surface: 'terminal', choices: {} }
  )
})
