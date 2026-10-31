// @vitest-environment happy-dom
import { mocks, projects, Draft, Entry, main } from './new-thread.test-fixture'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/store-test-helpers'
import { promptEditor } from '../native-chat/native-chat-prompt-editor.test-support'
import { selectThread, openNewThread } from './thread-actions'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'
import { useThreadDraft, threadDraftScopeKey } from './thread-navigation'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  hydrateNativeChatComposerDrafts,
  clearNativeChatComposerDraftsForTests,
  flushNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled
} from '../native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../native-chat/native-chat-composer-draft-storage'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'

it('re-enters unsent text and explicit choices after actual ordinary navigation', async () => {
  const { openNewThread } = await import('./thread-actions')
  await act(async () => openNewThread())
  render(<Entry />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Opus/ }))
  fireEvent.click(screen.getByRole('option', { name: /Codex/ }))
  fireEvent.click(screen.getByRole('button', { name: /Agent gpt/ }))
  const model = screen.getAllByRole('option').find((node) => node.textContent === 'Opus 1M')
  if (!model) {
    throw new Error('model choice missing')
  }
  fireEvent.click(model)
  fireEvent.pointerDown(screen.getByRole('button', { name: /Ask/ }), { button: 0, ctrlKey: false })
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Approve for me/ }))
  const composer = screen.getByRole('textbox', { name: /Ask for changes/ })
  act(() => promptEditor(composer).commands.insertContent('Reachable P'))
  const ordinary = makeUnifiedTab({
    id: 'ordinary',
    entityId: 'ordinary',
    worktreeId: projects[0].worktree.id,
    groupId: 'g',
    contentType: 'agent-session',
    executionHostId: 'local',
    agentSessionAgent: 'codex'
  })
  act(() => {
    useAppStore.setState({
      unifiedTabsByWorktree: { [ordinary.worktreeId]: [ordinary] },
      groupsByWorktree: {
        [ordinary.worktreeId]: [
          makeTabGroup({
            id: 'g',
            worktreeId: ordinary.worktreeId,
            tabOrder: [ordinary.id],
            activeTabId: ordinary.id
          })
        ]
      },
      activeGroupIdByWorktree: { [ordinary.worktreeId]: 'g' }
    })
    selectThread(ordinary)
  })
  expect(screen.queryByRole('textbox', { name: /Ask for changes/ })).toBeNull()
  fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true, altKey: true })
  await screen.findByRole('textbox', { name: /Ask for changes/ })
  expect(screen.getByRole('textbox', { name: /Ask for changes/ }).textContent).toBe('Reachable P')
  expect(screen.getByRole('button', { name: /Agent Opus/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Approve for me/ })).toBeTruthy()
  mocks.launch.mockImplementation(async (intent) => {
    await Promise.resolve()
    intent.createMessageSupport = true
    intent.prepareCreate?.(true)
    intent.createPrepared = true
    throw new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
  })
  fireEvent.keyDown(screen.getByRole('textbox', { name: /Ask for changes/ }), { key: 'Enter' })
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({
    agent: 'codex',
    explicitLaunchOptions: { model: 'opus[1m]', permissionMode: 'auto' },
    params: { firstMessage: { body: { blocks: [{ type: 'text', text: 'Reachable P' }] } } }
  })
})

it('hydrates the reachable compose slot without opening it, and only explicit close discards it', async () => {
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set('thread-draft:old-review-record', {
    text: 'Old retained input',
    images: [],
    savedAt: 1
  })
  setNativeChatComposerDraftStorageForTests(storage)
  const view = render(<Draft />)
  act(() => promptEditor(screen.getByRole('textbox')).commands.insertContent('Persisted P'))
  flushNativeChatComposerDrafts()
  await nativeChatComposerDraftWritesSettled()
  expect(storage.drafts.get(threadDraftScopeKey())?.text).toBe('Persisted P')
  view.unmount()
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(storage)
  useThreadDraft.setState({ draft: null })
  useAppStore.setState({ activeView: 'terminal' })
  await hydrateNativeChatComposerDrafts()
  render(<Entry />)
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
  const composer = await screen.findByRole('textbox', { name: /Ask for changes/ })
  expect(composer.textContent).toBe('Persisted P')
  act(() => expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(true))
  await act(async () => openNewThread())
  expect(screen.getByRole('textbox', { name: /Ask for changes/ }).textContent).toBe('')
  flushNativeChatComposerDrafts()
  await nativeChatComposerDraftWritesSettled()
  expect(storage.drafts.has(threadDraftScopeKey())).toBe(false)
  expect(storage.drafts.get('thread-draft:old-review-record')?.text).toBe('Old retained input')
})

it.each([
  { admissions: ['admitted', 'declined'], order: [0, 1], recovered: 'Newer Q' },
  { admissions: ['admitted', 'declined'], order: [1, 0], recovered: 'Newer Q' },
  { admissions: ['declined', 'admitted'], order: [1, 0], recovered: 'Old P' },
  { admissions: ['admitted', 'admitted'], order: [0, 1], recovered: '' },
  { admissions: ['admitted', 'admitted'], order: [1, 0], recovered: '' },
  { admissions: ['declined', 'declined'], order: [0, 1], recovered: 'Old P' },
  { admissions: ['declined', 'declined'], order: [1, 0], recovered: 'Newer Q' }
] as const)(
  'overlapping submitted captures retain one owner per prompt: %j',
  async ({ admissions, order, recovered }) => {
    const held = [
      Promise.withResolvers<{ kind: 'admitted' | 'declined' }>(),
      Promise.withResolvers<{ kind: 'admitted' | 'declined' }>()
    ]
    const creates: ReturnType<typeof Promise.withResolvers<never>>[] = []
    mocks.support
      .mockReset()
      .mockReturnValueOnce(held[0].promise)
      .mockReturnValueOnce(held[1].promise)
    mocks.launch.mockImplementation(async (intent) => {
      await Promise.resolve()
      intent.createMessageSupport = true
      intent.prepareCreate?.(true)
      intent.createPrepared = true
      const create = Promise.withResolvers<never>()
      creates.push(create)
      return create.promise
    })
    render(<Entry />)
    let composer = screen.getByRole('textbox', { name: /Ask for changes/ })
    act(() => promptEditor(composer).commands.insertContent('Old P'))
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(mocks.support).toHaveBeenCalledTimes(1))
    const ownerId = useThreadDraft.getState().draft!.draftId
    const ordinary = makeUnifiedTab({
      id: 'ordinary',
      entityId: 'ordinary',
      worktreeId: projects[0].worktree.id,
      groupId: 'g',
      contentType: 'agent-session',
      executionHostId: 'local',
      agentSessionAgent: 'codex'
    })
    act(() => {
      useAppStore.setState({
        unifiedTabsByWorktree: { [ordinary.worktreeId]: [ordinary] },
        groupsByWorktree: {
          [ordinary.worktreeId]: [
            makeTabGroup({
              id: 'g',
              worktreeId: ordinary.worktreeId,
              tabOrder: [ordinary.id],
              activeTabId: ordinary.id
            })
          ]
        },
        activeGroupIdByWorktree: { [ordinary.worktreeId]: 'g' }
      })
      selectThread(ordinary)
    })
    expect(screen.queryByRole('textbox', { name: /Ask for changes/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    composer = await screen.findByRole('textbox', { name: /Ask for changes/ })
    expect(useThreadDraft.getState().draft!.draftId).toBe(ownerId)
    act(() => promptEditor(composer).commands.insertContent('Newer Q'))
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(mocks.support).toHaveBeenCalledTimes(2))
    expect(readNativeChatComposerDraft(threadDraftScopeKey()).text).toBe('')
    for (const index of order) {
      await act(async () => {
        held[index].resolve({ kind: admissions[index] })
        await main.settle()
      })
      if (index === order[0]) {
        expect(useThreadDraft.getState().draft!.draftId).toBe(ownerId)
      }
    }
    await act(async () => {
      for (const create of creates) {
        create.reject(
          new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
        )
      }
    })
    const allocated = Object.values(useAppStore.getState().unifiedTabsByWorktree)
      .flat()
      .filter((t) => t.id !== ordinary.id)
    const expected = ['Old P', 'Newer Q'].filter((_, i) => admissions[i] === 'admitted')
    expect(
      allocated
        .map(
          (t) => readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(t.entityId)).text
        )
        .sort()
    ).toEqual(expected.sort())
    await act(async () => openNewThread())
    expect(screen.getByRole('textbox', { name: /Ask for changes/ }).textContent).toBe(recovered)
    // All captures settled: a fresh allocation can consume empty content rather than leaking a membership.
    const nextId = useThreadDraft.getState().draft!.draftId
    mocks.support.mockResolvedValue({ kind: 'admitted' })
    act(() =>
      promptEditor(screen.getByRole('textbox', { name: /Ask for changes/ })).commands.setContent(
        'Next use'
      )
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: /Ask for changes/ }), { key: 'Enter' })
    await waitFor(() => expect(useThreadDraft.getState().draft!.draftId).not.toBe(nextId))
    await act(async () => {
      creates
        .at(-1)
        ?.reject(
          new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
        )
    })
  }
)

it.each(['typing', 'project-choice', 'discard'] as const)(
  'unallocated recovery respects actual current content/provenance: %s',
  async (edit) => {
    const admission = Promise.withResolvers<{ kind: 'declined' }>()
    mocks.support.mockReturnValueOnce(admission.promise)
    render(<Entry />)
    const submitted = screen.getByRole('textbox', { name: /Ask for changes/ })
    act(() => promptEditor(submitted).commands.insertContent('Old P'))
    fireEvent.keyDown(submitted, { key: 'Enter' })
    await waitFor(() => expect(mocks.support).toHaveBeenCalledOnce())
    if (edit === 'discard') {
      act(() => expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(true))
      await act(async () => openNewThread())
    } else {
      // A different foreground section unmounts the submitting composer; + re-enters its same content owner.
      act(() => useAppStore.getState().openSettingsPage())
      await act(async () => openNewThread())
      act(() => useAppStore.getState().closeSettingsPage())
    }
    const composer = await screen.findByRole('textbox', { name: /Ask for changes/ })
    if (edit === 'typing') {
      act(() => promptEditor(composer).commands.insertContent('New Q'))
    }
    if (edit === 'project-choice') {
      fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
      fireEvent.click(screen.getByRole('option', { name: 'B' }))
      fireEvent.pointerDown(screen.getByRole('button', { name: /Ask/ }), {
        button: 0,
        ctrlKey: false
      })
      fireEvent.click(screen.getByRole('menuitemradio', { name: /Approve for me/ }))
    }
    await act(async () => {
      admission.resolve({ kind: 'declined' })
      await main.settle()
    })
    expect(composer.textContent).toBe(
      edit === 'typing' ? 'New Q' : edit === 'discard' ? '' : 'Old P'
    )
    if (edit === 'project-choice') {
      expect(screen.getByRole('button', { name: 'Choose project' }).textContent).toBe('B')
      expect(screen.getByRole('button', { name: /Approve for me/ })).toBeTruthy()
    }
    expect(mocks.launch).not.toHaveBeenCalled()
  }
)
