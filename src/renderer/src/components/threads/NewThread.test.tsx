// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promptEditor } from '../native-chat/native-chat-prompt-editor.test-support'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'

const mocks = vi.hoisted(() => ({ projects: vi.fn(), send: vi.fn() }))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      activeModal: 'none',
      repos: [],
      dictationState: 'idle',
      settings: { defaultTuiAgent: 'claude', voice: { enabled: false } },
      agentStatusByPaneKey: {},
      updateSettings: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn(),
      markNativeChatLaunchDraftAdopted: vi.fn()
    }))
  }
})
vi.mock('./use-thread-projects', () => ({ useThreadProjects: mocks.projects }))
vi.mock('./use-thread-launch-choices', () => ({
  useThreadLaunchChoices: () => ({
    agent: 'claude',
    launchInputs: {},
    picker: null,
    snapshot: [],
    surface: {
      getSnapshot: () => [],
      setOption: async () => ({ snapshot: [] }),
      invokeAction: async () => ({ snapshot: [] }),
      subscribe: () => () => {}
    }
  })
}))
vi.mock('./thread-actions', () => ({ sendNewThread: mocks.send }))
vi.mock('../native-chat/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('../native-chat/NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => null
}))
import { NewThread } from './NewThread'
import { useThreadNavigation } from './thread-navigation'
import { useAppStore } from '@/store'

const projects = ['A', 'B'].map((id) => ({
  key: `local|${id}`,
  hostId: 'local',
  repo: { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 1 },
  worktree: makeWorktree({ id: `${id}::/${id}`, repoId: id, path: `/${id}`, isMainWorktree: true })
}))
function Draft() {
  const selected = useThreadNavigation((s) => s.selection)
  return selected?.kind === 'new' ? <NewThread key={selected.draftId} {...selected} /> : null
}
beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  useThreadNavigation.setState({
    selection: { kind: 'new', projectKey: 'local|A', draftId: 'one' }
  })
  useAppStore.setState({ activeModal: 'none' })
  mocks.projects.mockReturnValue({ projects, loading: false })
  mocks.send.mockReset()
})
afterEach(cleanup)

it('focuses the real composer after capabilities arrive, while modal and project picker keep focus', async () => {
  mocks.projects.mockReturnValue({ projects: [], loading: true })
  const view = render(<Draft />)
  const composer = screen.getByRole('textbox', {
    name: 'Ask for changes, or ask anything about this project'
  })
  expect(document.activeElement).not.toBe(composer)
  const modal = document.createElement('input')
  document.body.append(modal)
  modal.focus()
  act(() => useAppStore.setState({ activeModal: 'add-repo' }))
  mocks.projects.mockReturnValue({ projects, loading: false })
  view.rerender(<Draft />)
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  expect(document.activeElement).toBe(modal)
  modal.remove()
  act(() => useAppStore.setState({ activeModal: 'none' }))
  await waitFor(() => expect(document.activeElement).toBe(composer))
  fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
  const search = screen.getByPlaceholderText('Search projects...')
  await waitFor(() => expect(document.activeElement).toBe(search))
  fireEvent.click(screen.getByRole('option', { name: 'B' }))
  await waitFor(() => expect(document.activeElement).toBe(composer))
  expect(screen.getByRole('button', { name: 'Choose project' }).textContent).toBe('B')
})

it.each<{ result: StructuredAgentLaunchSettlement; restore: boolean }>([
  { result: { kind: 'structured', sessionId: 'accepted-A' }, restore: false },
  { result: { kind: 'visibility-unknown', sessionId: 'accepted-A' }, restore: false },
  { result: { kind: 'failed', error: new Error('refused') }, restore: true },
  { result: { kind: 'cancelled', sessionId: null }, restore: true },
  { result: { kind: 'cancelled', sessionId: 'accepted-A' }, restore: false }
])(
  'keeps project B navigation after $result.kind settlement of A, restoring only proven unsent input',
  async ({ result, restore }) => {
    let settle: (value: StructuredAgentLaunchSettlement) => void = () => {}
    mocks.send.mockReturnValue({
      ownsPrompt: () => false,
      settlement: new Promise<StructuredAgentLaunchSettlement>((resolve) => {
        settle = resolve
      })
    })
    render(<Draft />)
    const composer = screen.getByRole('textbox', {
      name: 'Ask for changes, or ask anything about this project'
    })
    act(() => promptEditor(composer).commands.insertContent('Prompt for A'))
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(projects[0], 'Prompt for A', {
        agent: 'claude',
        launchOptions: undefined
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
    fireEvent.click(screen.getByRole('option', { name: 'B' }))
    await act(async () => settle(result))
    expect(useThreadNavigation.getState().selection).toMatchObject({
      projectKey: 'local|B',
      draftId: 'one'
    })
    await waitFor(() => expect(composer.textContent).toBe(restore ? 'Prompt for A' : ''))
  }
)

it.each(['refused', 'thrown'] as const)(
  'retains the actual composer input when launch is %s before admission',
  async (outcome) => {
    mocks.send.mockImplementation(() => {
      if (outcome === 'thrown') {
        throw new Error('host unavailable')
      }
      return null
    })
    render(<Draft />)
    const composer = screen.getByRole('textbox')
    act(() => promptEditor(composer).commands.insertContent('Keep this prompt'))
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
    expect(composer.textContent).toBe('Keep this prompt')
    expect(useThreadNavigation.getState().selection).toMatchObject({ projectKey: 'local|A' })
  }
)

it('cannot restore a failed older draft into a different new draft', async () => {
  let settle: (value: StructuredAgentLaunchSettlement) => void = () => {}
  mocks.send.mockReturnValue({
    ownsPrompt: () => false,
    settlement: new Promise<StructuredAgentLaunchSettlement>((resolve) => {
      settle = resolve
    })
  })
  render(<Draft />)
  act(() => promptEditor(screen.getByRole('textbox')).commands.insertContent('Old prompt'))
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
  act(() =>
    useThreadNavigation.setState({
      selection: { kind: 'new', projectKey: 'local|B', draftId: 'two' }
    })
  )
  act(() => promptEditor(screen.getByRole('textbox')).commands.insertContent('New prompt'))
  await act(async () => settle({ kind: 'failed', error: new Error('refused') }))
  expect(screen.getByRole('textbox').textContent).toBe('New prompt')
})

it.each([20, 200])(
  'keeps the loading headline without rescanning %i repos on unrelated writes',
  (count) => {
    const repos = [
      ...Array.from({ length: count }, (_, i) => ({ ...projects[0].repo, id: `other-${i}` })),
      projects[0].repo
    ]
    useAppStore.setState({ repos })
    mocks.projects.mockReturnValue({ projects: [], loading: true })
    render(<Draft />)
    expect(screen.getByRole('button', { name: 'Choose project' }).textContent).toBe('A')
    const find = vi.spyOn(repos, 'find')
    for (let i = 0; i < 3; i++) {
      act(() => useAppStore.setState({ agentStatusByPaneKey: {} }))
    }
    expect(find).not.toHaveBeenCalled()
    find.mockRestore()
  }
)

it.each(['cancel', 'added'] as const)(
  'preserves the real unsent prompt across Add project %s',
  async (outcome) => {
    const openModal = vi.fn(() => useAppStore.setState({ activeModal: 'add-repo' }))
    useAppStore.setState({ openModal })
    const view = render(<Draft />)
    act(() => promptEditor(screen.getByRole('textbox')).commands.insertContent('Keep my draft'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
    fireEvent.click(screen.getByRole('option', { name: 'Add project' }))
    expect(openModal).toHaveBeenCalledWith('add-repo')
    if (outcome === 'added') {
      mocks.projects.mockReturnValue({
        projects: [
          ...projects,
          {
            ...projects[1],
            key: 'local|C',
            repo: { ...projects[1].repo, id: 'C', displayName: 'C' }
          }
        ],
        loading: false
      })
    }
    act(() => useAppStore.setState({ activeModal: 'none' }))
    view.rerender(<Draft />)
    expect(screen.getByRole('textbox').textContent).toBe('Keep my draft')
    expect(screen.getByRole('button', { name: 'Choose project' }).textContent).toBe('A')
    expect(mocks.send).not.toHaveBeenCalled()
  }
)
