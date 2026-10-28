// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NewWorkspaceComposerCardProps } from './new-workspace/new-workspace-composer-card-props'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import type { HostStructuredAgentAvailability } from '@/runtime/host-structured-agent-availability'
import { TooltipProvider } from '@/components/ui/tooltip'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import NewWorkspaceComposerModal from './NewWorkspaceComposerModal'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  resolveDefault: vi.fn(),
  repoId: ((): string | null => null)(),
  projectGroupId: ((): string | null => null)(),
  host: 'local',
  folderRepos: Array<string>(),
  availability: vi.fn<() => HostStructuredAgentAvailability>()
}))
vi.mock('@/lib/desktop-workspace-default-agent', () => ({
  resolveDesktopWorkspaceDefaultAgent: mocks.resolveDefault
}))
vi.mock('@/runtime/use-host-structured-agent-availability', () => ({
  useHostStructuredAgentAvailability: mocks.availability
}))
vi.mock('@/components/agent/AgentSettingsDialog', () => ({ default: () => null }))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'opencode'],
    isLoading: false,
    detectionFailed: false,
    needsServerUpdate: false
  })
}))
vi.mock('@/hooks/useComposerState', () => ({
  useComposerState: () => ({
    cardProps: {
      projectOptions: mocks.projectGroupId
        ? [{ id: mocks.projectGroupId, kind: 'project-group', displayName: 'Group' }]
        : [],
      selectedProjectId: mocks.projectGroupId,
      repoId: mocks.repoId,
      selectedRepoExecutionHostId: mocks.host,
      selectedRepoIsGit: true,
      repoBackedSearchRepos: mocks.folderRepos.map((id) => ({ id })),
      detectedAgentIds: new Set(['claude', 'codex', 'opencode']),
      agentRows: {
        target: { workspace: { kind: 'git-worktree', executionHostId: mocks.host } },
        detectionTarget: { kind: 'local' }
      }
    },
    composerRef: useRef(null),
    submitQuick: mocks.submit,
    createDisabled: false
  })
}))
// Keep the actual owner/handler and picker; unrelated project/name fields are outside this seam.
vi.mock('@/components/NewWorkspaceComposerCard', () => ({
  default: (p: NewWorkspaceComposerCardProps) => (
    <div ref={p.composerRef}>
      <AgentCombobox
        agents={AGENT_CATALOG}
        value={p.quickAgent}
        onValueChange={p.onQuickAgentChange}
        allowBlankTerminal
        surfaceRows={p.agentSurfaceRows}
      />
      <button onClick={p.onCreate} disabled={p.createDisabled}>
        Create
      </button>
      <button onClick={() => p.onQuickAgentChange(null)}>Blank</button>
      <button onClick={p.onQuickSetupOnlySelect}>Setup only</button>
      <button onClick={() => p.onQuickAgentChange('claude', 'terminal')}>Choose CLI</button>
      <button onClick={() => p.onQuickAgentChange('claude', 'chat')}>Choose chat</button>
    </div>
  )
}))
const initial = useAppStore.getState()
beforeEach(() => {
  mocks.submit.mockReset()
  mocks.resolveDefault.mockReset()
  mocks.repoId = null
  mocks.projectGroupId = null
  mocks.host = 'local'
  mocks.folderRepos = []
  mocks.availability.mockReturnValue({ state: 'pending' })
  setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
  useAppStore.setState({
    activeModal: 'new-workspace-composer',
    modalData: {},
    settings: {
      ...getDefaultSettings('/test'),
      experimentalNativeChat: true,
      defaultTuiAgent: 'claude'
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})
const create = () => screen.getByRole('button', { name: 'Create' })
const submit = async () => {
  await act(async () => fireEvent.click(create()))
}

it('gates the selected chat at click/keyboard, preserves terminal and blank exceptions, and repairs host changes', async () => {
  setLocalRuntimeCapabilitiesForTests(null)
  const view = render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  expect(create().hasAttribute('disabled')).toBe(true)
  await submit()
  fireEvent.keyDown(create(), { key: 'Enter', ctrlKey: true })
  fireEvent.keyDown(create(), { key: 'Enter', metaKey: true })
  expect(mocks.submit).not.toHaveBeenCalled()
  act(() => setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES))
  fireEvent.click(screen.getByText('Blank'))
  await submit()
  expect(mocks.submit).toHaveBeenLastCalledWith(null, expect.objectContaining({ setupOnly: false }))
  fireEvent.click(screen.getByText('Setup only'))
  await submit()
  expect(mocks.submit).toHaveBeenLastCalledWith(null, expect.objectContaining({ setupOnly: true }))
  fireEvent.click(screen.getByText('Choose CLI'))
  expect(screen.getByRole('combobox').textContent).toContain('Claude (CLI)')
  await submit()
  expect(mocks.submit.mock.calls.at(-1)?.[1].launchChoice).toMatchObject({
    route: 'terminal-tui',
    requestedSurface: 'terminal'
  })
  mocks.availability.mockReturnValue({
    state: 'received',
    byAgent: new Map([['claude', { agent: 'claude', state: 'available' }]])
  })
  fireEvent.click(screen.getByText('Choose chat'))
  await submit()
  expect(mocks.submit.mock.calls.at(-1)?.[1].launchChoice).toMatchObject({
    route: 'structured-native-chat',
    requestedSurface: 'chat'
  })
  mocks.host = 'ssh:other'
  view.rerender(<NewWorkspaceComposerModal />)
  expect(screen.getByRole('combobox').textContent).toContain('Claude (CLI)')
  await submit()
  expect(mocks.submit.mock.calls.at(-1)?.[1].launchChoice).toMatchObject({
    route: 'terminal-tui',
    requestedSurface: 'terminal'
  })
})

it('submits the untouched refusal-aware OpenCode CLI instead of the registered catalog chat', async () => {
  mocks.availability.mockReturnValue({
    state: 'received',
    byAgent: new Map([['opencode', { agent: 'opencode', state: 'refused' }]])
  })
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  act(() =>
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/test'),
        experimentalNativeChat: true,
        defaultTuiAgent: 'opencode'
      }
    })
  )
  expect(screen.getByRole('combobox').textContent).toContain('OpenCode (CLI)')
  await submit()
  expect(mocks.submit.mock.calls[0][1].launchChoice).toMatchObject({
    agent: 'opencode',
    route: 'terminal-tui'
  })
  expect(mocks.submit.mock.calls[0][1].launchChoice.requestedSurface).toBeUndefined()
})

it('uses the target host default at submission and keeps an explicit override', async () => {
  mocks.repoId = 'repo-b'
  act(() =>
    useAppStore.setState({
      settings: { ...getDefaultSettings('/test'), defaultTuiAgent: 'claude' }
    })
  )
  mocks.availability.mockReturnValue({
    state: 'received',
    byAgent: new Map([['claude', { agent: 'claude', state: 'available' }]])
  })
  mocks.resolveDefault.mockResolvedValue({ agent: 'claude', source: 'project', projectId: 'B' })
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  await submit()
  expect(mocks.resolveDefault).toHaveBeenCalledWith({ repo: 'repo-b', hostId: 'local' })
  expect(mocks.submit.mock.calls[0]?.[0]).toBe('claude')

  fireEvent.click(screen.getByText('Choose CLI'))
  await submit()
  expect(mocks.resolveDefault).toHaveBeenCalledTimes(1)
  expect(mocks.submit.mock.calls[1]?.[0]).toBe('claude')
})

it('refuses an inferred agent for a folder group without a single target project', async () => {
  mocks.projectGroupId = 'project-group:multiple'
  mocks.folderRepos = ['repo-a', 'repo-b']
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  await submit()
  expect(mocks.resolveDefault).not.toHaveBeenCalled()
  expect(mocks.submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Choose CLI'))
  await submit()
  expect(mocks.submit.mock.calls[0]?.[0]).toBe('claude')
})

it('allows a blank folder group workspace without choosing a project agent', async () => {
  mocks.projectGroupId = 'project-group:multiple'
  mocks.folderRepos = ['repo-a', 'repo-b']
  useAppStore.setState({
    settings: { ...getDefaultSettings('/test'), defaultTuiAgent: 'blank' }
  })
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  expect(screen.getByRole('combobox').textContent).toContain('Blank Terminal')
  expect(create().hasAttribute('disabled')).toBe(false)
  await submit()
  expect(mocks.resolveDefault).not.toHaveBeenCalled()
  expect(mocks.submit).toHaveBeenCalledWith(null, expect.anything())
})

it('resolves a single folder group project on the target host before creating', async () => {
  mocks.projectGroupId = 'project-group:single'
  mocks.folderRepos = ['repo-b']
  mocks.repoId = 'repo-b'
  useAppStore.setState({
    projects: [
      {
        id: 'B',
        displayName: 'B',
        badgeColor: '',
        sourceRepoIds: ['repo-b'],
        defaultTuiAgent: 'claude',
        createdAt: 0,
        updatedAt: 0
      }
    ]
  })
  mocks.availability.mockReturnValue({
    state: 'received',
    byAgent: new Map([['claude', { agent: 'claude', state: 'available' }]])
  })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/test'), defaultTuiAgent: 'opencode' }
  })
  mocks.resolveDefault.mockResolvedValue({ agent: 'claude', source: 'project', projectId: 'B' })
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  expect(screen.getByRole('combobox').textContent).toContain('Claude')
  expect(create().hasAttribute('disabled')).toBe(false)
  await submit()
  expect(mocks.resolveDefault).toHaveBeenCalledWith({ repo: 'repo-b', hostId: 'local' })
  expect(mocks.submit).toHaveBeenCalledWith('claude', expect.anything())
  mocks.resolveDefault.mockRejectedValueOnce(new Error('Claude unavailable on target host'))
  await submit()
  expect(mocks.submit).toHaveBeenCalledTimes(1)
})

it('rechecks the host default after an unavailable explicit pick is repaired', async () => {
  mocks.repoId = 'repo-b'
  mocks.resolveDefault.mockResolvedValue({ agent: 'claude', source: 'project', projectId: 'B' })
  const view = render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  fireEvent.click(screen.getByText('Choose CLI'))
  act(() =>
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/test'),
        defaultTuiAgent: 'claude',
        disabledTuiAgents: ['claude']
      }
    })
  )
  view.rerender(<NewWorkspaceComposerModal />)
  await submit()
  expect(mocks.resolveDefault).toHaveBeenCalledWith({ repo: 'repo-b', hostId: 'local' })
})

it('admits only one create while default resolution and submission are pending', async () => {
  mocks.repoId = 'repo-b'
  useAppStore.setState({
    settings: { ...getDefaultSettings('/test'), defaultTuiAgent: 'blank' }
  })
  const resolution = Promise.withResolvers<{ agent: null; source: 'global' }>()
  const creation = Promise.withResolvers<void>()
  mocks.resolveDefault.mockReturnValue(resolution.promise)
  mocks.submit.mockReturnValue(creation.promise)
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  fireEvent.click(create())
  fireEvent.click(create())
  fireEvent.keyDown(create(), { key: 'Enter', ctrlKey: true })
  fireEvent.keyDown(create(), { key: 'Enter', metaKey: true })
  expect(mocks.resolveDefault).toHaveBeenCalledTimes(1)
  expect(create().hasAttribute('disabled')).toBe(true)
  await act(async () => resolution.resolve({ agent: null, source: 'global' }))
  expect(mocks.submit).toHaveBeenCalledTimes(1)
  fireEvent.click(create())
  expect(mocks.resolveDefault).toHaveBeenCalledTimes(1)
  await act(async () => creation.resolve())
  expect(create().hasAttribute('disabled')).toBe(false)
})

it('loads the remote inherited default before local chat readiness can block Create', async () => {
  mocks.repoId = 'repo-b'
  mocks.host = 'runtime:remote'
  const resolution = Promise.withResolvers<{ agent: null; source: 'global' }>()
  mocks.resolveDefault.mockReturnValue(resolution.promise)
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  expect(mocks.resolveDefault).toHaveBeenCalledWith({ repo: 'repo-b', hostId: 'runtime:remote' })
  expect(create().hasAttribute('disabled')).toBe(true)
  await act(async () => resolution.resolve({ agent: null, source: 'global' }))
  expect(screen.getByRole('combobox').textContent).toContain('Blank Terminal')
  expect(create().hasAttribute('disabled')).toBe(false)
  await submit()
  expect(mocks.submit).toHaveBeenCalledWith(null, expect.anything())
  expect(mocks.resolveDefault).toHaveBeenCalledTimes(2)
})

it('shows a remote compatibility refusal and permits an explicit blank override', async () => {
  mocks.repoId = 'repo-b'
  mocks.host = 'runtime:old'
  mocks.resolveDefault.mockRejectedValue(new Error('Update the target Orca host'))
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toBe('Update the target Orca host')
  await submit()
  expect(mocks.submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Blank'))
  await submit()
  expect(mocks.submit).toHaveBeenCalledWith(null, expect.anything())
  expect(mocks.resolveDefault).toHaveBeenCalledTimes(2)
})

it('ignores an old remote default reply after switching target projects', async () => {
  mocks.repoId = 'repo-b'
  mocks.host = 'runtime:remote'
  const oldResolution = Promise.withResolvers<{ agent: 'claude'; source: 'global' }>()
  mocks.resolveDefault.mockReturnValueOnce(oldResolution.promise)
  mocks.resolveDefault.mockResolvedValue({ agent: null, source: 'global' })
  const view = render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  mocks.repoId = 'repo-c'
  view.rerender(<NewWorkspaceComposerModal />)
  await act(async () => {})
  expect(screen.getByRole('combobox').textContent).toContain('Blank Terminal')
  await act(async () => oldResolution.resolve({ agent: 'claude', source: 'global' }))
  expect(screen.getByRole('combobox').textContent).toContain('Blank Terminal')
  expect(create().hasAttribute('disabled')).toBe(false)
})

it('keeps the new target default when an earlier target submission finishes resolving', async () => {
  mocks.repoId = 'repo-b'
  mocks.host = 'runtime:remote'
  const submissionResolution = Promise.withResolvers<{ agent: null; source: 'global' }>()
  mocks.resolveDefault.mockResolvedValueOnce({ agent: null, source: 'global' })
  mocks.resolveDefault.mockReturnValueOnce(submissionResolution.promise)
  mocks.resolveDefault.mockResolvedValue({ agent: null, source: 'global' })
  const view = render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  await act(async () => {})
  fireEvent.click(create())
  expect(mocks.resolveDefault).toHaveBeenCalledTimes(2)
  mocks.repoId = 'repo-c'
  view.rerender(<NewWorkspaceComposerModal />)
  await act(async () => {})
  expect(mocks.resolveDefault).toHaveBeenCalledTimes(3)
  await act(async () => submissionResolution.resolve({ agent: null, source: 'global' }))
  expect(mocks.submit).toHaveBeenCalledTimes(1)
  expect(create().hasAttribute('disabled')).toBe(false)
  expect(screen.queryByText('Resolving target project default…')).toBeNull()
})
