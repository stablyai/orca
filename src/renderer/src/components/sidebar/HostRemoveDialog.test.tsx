// @vitest-environment happy-dom
import { currentDraftScope } from '../native-chat/native-chat-launch-draft-source'

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { HostRemoveDialog } from './HostRemoveDialog'

const initialState = useAppStore.getState()
const onOpenChange = vi.fn()

function dialogs(openHost: string | null) {
  return ['one', 'two'].map((id) => (
    <HostRemoveDialog
      key={id}
      open={openHost === id}
      onOpenChange={onOpenChange}
      hostId={`ssh:${id}`}
      label={id}
      target={{ kind: 'ssh', targetId: id }}
    />
  ))
}

function replaceCatalogs(count: number) {
  useAppStore.setState({
    worktreesByRepo: {
      [TEST_REPO.id]: Array.from({ length: count }, (_, index) =>
        makeWorktree({ id: `workspace-${index}`, repoId: TEST_REPO.id })
      )
    },
    detectedWorktreesByRepo: {}
  })
}

beforeEach(() => {
  useAppStore.setState({
    repos: [{ ...TEST_REPO, connectionId: 'one' }],
    openFiles: [],
    editorDrafts: {}
  })
  replaceCatalogs(1)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('releases both obsolete catalogs and cached indexes while host dialogs stay mounted', async () => {
  const view = render(dialogs(null))

  function openAndCloseHost(id: string) {
    view.rerender(dialogs(id))
    expect(screen.getByRole('dialog')).toHaveTextContent(`Remove ${id}?`)
    const state = useAppStore.getState()
    const retired = {
      worktrees: new WeakRef(state.worktreesByRepo),
      detected: new WeakRef(state.detectedWorktreesByRepo),
      index: new WeakRef(getWorktreeMapFromState(state))
    }
    view.rerender(dialogs(null))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => replaceCatalogs(2))
    return retired
  }

  const retiredCatalogs = ['one', 'two'].map(openAndCloseHost)
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
  for (const retired of retiredCatalogs) {
    expect(retired.worktrees.deref()).toBeUndefined()
    expect(retired.detected.deref()).toBeUndefined()
    expect(retired.index.deref()).toBeUndefined()
  }

  view.rerender(dialogs('one'))
  expect(screen.getByRole('dialog')).toHaveTextContent('Its 3 workspaces stay in Orca')
})

it('keeps workspace details through the closing animation', () => {
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, ...args) => {
    const style = getStyle(element, ...args)
    if (element.getAttribute('data-slot') === 'dialog-content') {
      return new Proxy(style, {
        get: (target, property) =>
          property === 'animationName'
            ? element.getAttribute('data-state') === 'closed'
              ? 'exit'
              : 'enter'
            : // oxlint-disable-next-line anti-slop/no-reflect-get -- Forward CSS properties without changing their receiver.
              Reflect.get(target, property)
      })
    }
    return style
  })
  const view = render(dialogs('one'))
  const dialog = screen.getByRole('dialog')
  const removeButton = screen.getByRole('button', { name: 'Remove host' })
  expect(removeButton).toBeEnabled()
  expect(dialog).toHaveTextContent('Its 2 workspaces stay in Orca')

  view.rerender(dialogs(null))
  expect(dialog).toBeInTheDocument()
  expect(dialog).toHaveAttribute('data-state', 'closed')
  expect(removeButton).toBeDisabled()
  expect(dialog).toHaveTextContent('Its 2 workspaces stay in Orca')

  const event = new Event('animationend', { bubbles: true })
  Object.defineProperty(event, 'animationName', { value: 'exit' })
  fireEvent(dialog, event)
  expect(dialog).not.toBeInTheDocument()
})

it.each(['success', 'failure'] as const)(
  'keeps removal pending across dismiss/reopen and releases it after %s',
  async (outcome) => {
    const pending = Promise.withResolvers<void>()
    const remove = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('api', { ssh: { removeTarget: remove } })
    useAppStore.setState({
      clearRemovedSshTargetState: vi.fn(),
      updateSettings: vi.fn().mockResolvedValue(undefined)
    })
    const view = render(dialogs('one'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove host' }))
    expect(remove).toHaveBeenCalledTimes(1)
    view.rerender(dialogs(null))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    view.rerender(dialogs('one'))
    const button = screen.getByRole('button', { name: 'Remove host' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(remove).toHaveBeenCalledTimes(1)

    await act(async () => {
      if (outcome === 'success') {
        pending.resolve()
      } else {
        pending.reject(new Error('Removal failed'))
      }
      await pending.promise.catch(() => {})
    })
    expect(button).toBeEnabled()
  }
)

import { useNativeChatDraft } from '../native-chat/use-native-chat-draft'
import * as draftStore from '../native-chat/native-chat-composer-draft-store'
import {
  addNativeChatPendingAttachment,
  nativeChatPendingAttachmentSnapshot
} from '../native-chat/native-chat-pending-attachment-cache'
import { addAllSshConfigHostsToOrca } from './add-remote-host-ssh-actions'

it.each([false, true])(
  'kept SSH setup input follows actual import and accepted catalog in response-first=%s order',
  async (responseFirst) => {
    draftStore.clearNativeChatComposerDraftsForTests()
    const repo = { ...TEST_REPO, executionHostId: 'ssh:one' as const, connectionId: 'one' }
    const newRepo = { ...repo, executionHostId: 'ssh:two' as const, connectionId: 'two' }
    const workspace = `${repo.id}::/source-only`
    const scope = draftStore.nativeChatLaunchPromptDraftScopeKey(workspace, 'codex', 'ssh:one')
    const old = renderHook(() => useNativeChatDraft(scope, () => false))
    act(() => old.result.current.setDraft('unsent @/workspace/file'))
    addNativeChatPendingAttachment(scope, { id: 'kept-upload', path: '', pending: true })
    const captured = draftStore.captureNativeChatEditDraftDestination(scope)
    old.unmount()
    const imported = Promise.withResolvers<{
      targets: []
      repoReadoptions: { oldTargetId: string; newTargetId: string; repoIds: string[] }[]
    }>()
    const catalog = Promise.withResolvers<(typeof newRepo)[]>()
    const ssh = {
      removeTarget: vi.fn().mockResolvedValue(undefined),
      importConfig: vi.fn(() => imported.promise),
      listTargets: vi.fn().mockResolvedValue([]),
      addTarget: vi.fn(),
      listConfigHosts: vi.fn(),
      resolveConfigHost: vi.fn()
    }
    vi.stubGlobal('api', { ssh, repos: { list: vi.fn(() => catalog.promise) } })
    useAppStore.setState({ repos: [repo], updateSettings: vi.fn().mockResolvedValue(undefined) })
    const dialog = render(dialogs('one'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove host' })))
    expect(ssh.removeTarget).toHaveBeenCalledWith({ id: 'one' })
    expect(draftStore.readNativeChatComposerDraft(scope).text).toBe('unsent @/workspace/file')
    dialog.unmount()
    const fetching = useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    const adding = addAllSshConfigHostsToOrca({
      ssh,
      recordSshRepoReadoptions: useAppStore.getState().recordSshRepoReadoptions,
      setSshTargetsMetadata: vi.fn(),
      recordFeatureInteraction: vi.fn()
    })
    // Setup first acquired while the actual import RPC is held is included at acceptance.
    const duringRpc = draftStore.nativeChatLaunchPromptDraftScopeKey(
      `${repo.id}::/during-rpc`,
      'claude',
      'ssh:one'
    )
    draftStore.updateNativeChatComposerDraft(duringRpc, { text: 'opened during RPC' }, 'immediate')
    const descriptor = { oldTargetId: 'one', newTargetId: 'two', repoIds: [repo.id] }
    if (responseFirst) {
      imported.resolve({ targets: [], repoReadoptions: [descriptor] })
      await adding
      expect(useAppStore.getState().pendingSshRepoReadoptions).toHaveLength(1)
      expect(
        draftStore.readNativeChatComposerDraft(
          draftStore.nativeChatLaunchPromptDraftScopeKey(workspace, 'codex', 'ssh:two')
        ).text
      ).toBe('unsent @/workspace/file')
      // A first setup opened during accepted pending catalog uses the same continuing association.
      const duringPending = draftStore.nativeChatLaunchPromptDraftScopeKey(
        `${repo.id}::/during-pending`,
        'claude',
        'ssh:one'
      )
      draftStore.updateNativeChatComposerDraft(
        duringPending,
        { text: 'opened during pending catalog' },
        'immediate'
      )
      catalog.resolve([newRepo])
      await fetching
      expect(
        draftStore.readNativeChatComposerDraft(
          draftStore.nativeChatLaunchPromptDraftScopeKey(
            `${repo.id}::/during-pending`,
            'claude',
            'ssh:two'
          )
        ).text
      ).toBe('opened during pending catalog')
    } else {
      catalog.resolve([newRepo])
      await fetching
      imported.resolve({ targets: [], repoReadoptions: [descriptor] })
      await adding
    }
    expect(
      draftStore.readNativeChatComposerDraft(
        draftStore.nativeChatLaunchPromptDraftScopeKey(
          `${repo.id}::/during-rpc`,
          'claude',
          'ssh:two'
        )
      ).text
    ).toBe('opened during RPC')
    const current = draftStore.nativeChatLaunchPromptDraftScopeKey(workspace, 'codex', 'ssh:two')
    expect(draftStore.readNativeChatComposerDraft(current)).toBe(
      draftStore.readNativeChatComposerDraft(scope)
    )
    const reopened = renderHook(() => useNativeChatDraft(current, () => false))
    expect(reopened.result.current.draft).toBe('unsent @/workspace/file')
    expect(captured).toMatchObject({ scopeKey: currentDraftScope(current), active: true })
    expect(nativeChatPendingAttachmentSnapshot(current).map(({ id }) => id)).toEqual([
      'kept-upload'
    ])
    // Replay cannot claim a new occupant of the old address.
    const replacement = draftStore.nativeChatLaunchPromptDraftScopeKey(
      workspace,
      'codex',
      'ssh:one'
    )
    draftStore.updateNativeChatComposerDraft(
      replacement,
      { text: 'new old-address task' },
      'immediate'
    )
    useAppStore.getState().recordSshRepoReadoptions([descriptor])
    expect(draftStore.readNativeChatComposerDraft(replacement).text).toBe('new old-address task')
    reopened.unmount()
    draftStore.clearNativeChatComposerDraftsForTests()
  }
)
