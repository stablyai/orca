// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT } from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'
import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

const mocks = vi.hoisted(() => ({
  detection: vi.fn<() => UseDetectedAgentsResult>(),
  launch: vi.fn()
}))
vi.mock('@/hooks/useDetectedAgents', () => ({ useDetectedAgents: mocks.detection }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  launchAgentSessionContinuation: mocks.launch
}))
const initial = useAppStore.getState()
const request = {
  source: { capturedText: 'previous session', sourceAgent: 'codex' as const },
  worktreeId: 'wt-1',
  workspacePath: '/repo',
  groupId: 'group-1',
  initialCwd: '/repo/.',
  launchSource: 'sidebar' as const
}
const detection: UseDetectedAgentsResult = {
  detectedIds: ['codex'],
  isLoading: false,
  detectionFailed: false,
  isRefreshing: false,
  needsServerUpdate: false,
  refresh: async () => ['codex']
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.detection.mockReturnValue(detection)
  mocks.launch.mockResolvedValue(true)
  setLocalRuntimeCapabilitiesForTests([CHAT])
  useAppStore.setState({
    settings: { ...getDefaultSettings('/test'), experimentalNativeChat: true },
    repos: [{ id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it('clears failed detection, gates unresolved Start, and submits the displayed root/subfolder choice', async () => {
  const props = { open: true, request, onOpenChange: vi.fn() }
  mocks.detection.mockReturnValue({ ...detection, detectedIds: null, detectionFailed: true })
  const view = render(<AgentSessionContinuationDialog {...props} />, { wrapper: TooltipProvider })
  expect(screen.getByText('Could not detect Agents on this workspace host.')).toBeTruthy()
  mocks.detection.mockReturnValue({ ...detection, detectedIds: null, isLoading: true })
  view.rerender(<AgentSessionContinuationDialog {...props} request={{ ...request }} />)
  expect(screen.queryByText('Could not detect Agents on this workspace host.')).toBeNull()
  expect(screen.getByText('Detecting Agents on this workspace host…')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Start New Session' }))
  expect(mocks.launch).not.toHaveBeenCalled()
  mocks.detection.mockReturnValue(detection)
  view.rerender(<AgentSessionContinuationDialog {...props} />)
  fireEvent.click(screen.getAllByRole('combobox')[0])
  fireEvent.click(screen.getByRole('option', { name: /Codex/ }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({
    initialCwd: '/repo/.',
    groupId: 'group-1',
    launchChoice: { route: 'structured-native-chat', requestedSurface: 'chat' }
  })
  fireEvent.click(screen.getAllByRole('combobox')[0])
  fireEvent.click(screen.getByRole('button', { name: 'Start Codex in a terminal' }))
  expect(screen.getAllByRole('combobox')[0].textContent).toContain('Codex (CLI)')
  view.rerender(<AgentSessionContinuationDialog {...props} open={false} />)
  view.rerender(<AgentSessionContinuationDialog {...props} />)
  expect(screen.getAllByRole('combobox')[0].textContent).not.toContain('(CLI)')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch.mock.calls.at(-1)?.[0].launchChoice.requestedSurface).toBeUndefined()
  view.rerender(
    <AgentSessionContinuationDialog
      {...props}
      request={{ ...request, initialCwd: '/repo/packages/app' }}
    />
  )
  expect(screen.getAllByRole('combobox')[0].textContent).toContain('Codex (CLI)')
  fireEvent.click(screen.getAllByRole('combobox')[0])
  expect(screen.getAllByText('No chat in a subfolder').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('option', { name: 'Codex (CLI)' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch.mock.calls.at(-1)?.[0]).toMatchObject({
    initialCwd: '/repo/packages/app',
    launchChoice: { route: 'terminal-tui', requestedSurface: 'terminal' }
  })
})
