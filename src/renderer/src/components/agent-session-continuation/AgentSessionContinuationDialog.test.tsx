// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT } from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as StructuredAgentClient from '@/runtime/structured-agent-session-client'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'
import { useNativeChatHandOff } from '../native-chat/use-native-chat-hand-off'
import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  detection: vi.fn<() => UseDetectedAgentsResult>(),
  launch: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredAgentClient>()),
  supportsStructuredAgentSessionContinuationContext: mocks.capability
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
  mocks.capability.mockResolvedValue(false)
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

it.each(['chat', undefined] as const)(
  'labels useful %s fallback without promising older history',
  (sourceKind) => {
    render(
      <AgentSessionContinuationDialog
        open
        request={{ ...request, source: { ...request.source, sourceKind } }}
        onOpenChange={vi.fn()}
      />,
      { wrapper: TooltipProvider }
    )
    expect(
      screen.getByText(
        sourceKind === 'chat'
          ? 'Uses recent messages currently loaded in this chat and the current workspace.'
          : 'Uses captured text and the current workspace.'
      )
    ).toBeTruthy()
    expect(screen.queryByText(/reading older transcript details/)).toBeNull()
    expect(screen.getByText('/repo/.')).toBeTruthy()
  }
)

it('keeps the replacement chooser open when an earlier accepted launch completes', async () => {
  const cwd = `/repo/${'long-workspace-directory/'.repeat(12)}project`
  function Chat({ epoch }: { epoch: string }) {
    const handOff = useNativeChatHandOff({
      pane: {
        tabId: 'tab',
        sessionId: 'chat',
        agent: 'codex',
        isVisible: true,
        target: { kind: 'local' }
      },
      directory: { worktreeId: 'wt-1', worktreePath: cwd, runtimeEnvironmentId: null },
      epoch,
      messages: [
        {
          id: '1',
          source: 'transcript',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Saved task' }]
        }
      ],
      focusComposer: () => {}
    })
    return (
      <>
        <button onClick={() => handOff.open()}>Open hand-off</button>
        {handOff.dialog}
      </>
    )
  }
  const capability = Promise.withResolvers<boolean>()
  mocks.capability.mockReturnValueOnce(capability.promise)
  const launchA = Promise.withResolvers<boolean>()
  mocks.launch.mockReturnValueOnce(launchA.promise).mockResolvedValueOnce(true)
  const view = render(<Chat epoch="a" />, { wrapper: TooltipProvider })
  await act(async () => fireEvent.click(screen.getByText('Open hand-off')))
  expect(screen.getByText('Preparing saved chat context…')).toBeTruthy()
  expect(screen.getByText(cwd)).toBeTruthy()
  expect(
    screen.queryByText(/Detecting Agents|Uses captured|recent messages currently loaded/)
  ).toBeNull()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start New Session' }).disabled
  ).toBe(true)
  expect(screen.getAllByRole<HTMLButtonElement>('combobox').every((item) => item.disabled)).toBe(
    true
  )
  fireEvent.click(screen.getByText('Cancel'))
  await act(async () => capability.resolve(false))
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => fireEvent.click(screen.getByText('Open hand-off')))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch).toHaveBeenCalledOnce()
  view.rerender(<Chat epoch="b" />)
  await act(async () => fireEvent.click(screen.getByText('Open hand-off')))
  await act(async () => launchA.resolve(true))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start New Session' }).disabled
  ).toBe(false)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('dialog')).toBeNull()
})
