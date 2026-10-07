// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { makeOpenFile, makeTabGroup, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { useFloatingTerminalCloseActions } from './use-floating-terminal-close-actions'

const requestEditorFileClose = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/editor-autosave', () => ({ requestEditorFileClose }))

const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
const groupId = 'floating-group'
const sharedFileId = 'shared-file'
const editor = makeUnifiedTab({
  id: 'editor-one',
  worktreeId,
  groupId,
  contentType: 'editor',
  entityId: sharedFileId
})
const secondReference = makeUnifiedTab({
  id: 'editor-two',
  worktreeId,
  groupId: 'other-group',
  contentType: 'editor',
  entityId: sharedFileId
})
const chat = makeUnifiedTab({
  id: 'chat-one',
  worktreeId,
  groupId,
  contentType: 'agent-session',
  entityId: 'chat-session'
})
const pinnedEditor = makeUnifiedTab({
  id: 'pinned-editor',
  worktreeId,
  groupId,
  contentType: 'editor',
  entityId: 'pinned-file',
  isPinned: true
})
const group = makeTabGroup({
  id: groupId,
  worktreeId,
  activeTabId: editor.id,
  tabOrder: [editor.id, chat.id]
})

const closeFile = vi.fn<ReturnType<typeof useAppStore.getState>['closeFile']>()
const closeUnifiedTab = vi.fn<ReturnType<typeof useAppStore.getState>['closeUnifiedTab']>(
  () => null
)
const requestPinnedTabCloseConfirm = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    closeFile,
    closeUnifiedTab,
    requestPinnedTabCloseConfirm,
    unifiedTabsByWorktree: { [worktreeId]: [editor, chat, secondReference] },
    groupsByWorktree: { [worktreeId]: [group] },
    activeGroupIdByWorktree: { [worktreeId]: groupId },
    openFiles: [makeOpenFile({ id: sharedFileId, worktreeId })]
  })
})

function actions(groupTabs = [editor, chat]) {
  return renderHook(() => useFloatingTerminalCloseActions({ activeGroup: group, groupTabs })).result
    .current
}

function setPinnedConfirmation(confirmClosePinnedTab: boolean) {
  const settings = useAppStore.getState().settings ?? getDefaultSettings(process.cwd())
  useAppStore.setState({ settings: { ...settings, confirmClosePinnedTab } })
}

describe('floating titlebar close actions', () => {
  it('closes one editor reference while keeping its shared open file', () => {
    actions().closeFloatingItemConfirmed(editor.id)

    expect(closeFile).not.toHaveBeenCalled()
    expect(closeUnifiedTab).toHaveBeenCalledWith(editor.id)
  })

  it('closes editor tabs without closing structured chats from Close All Editor Tabs', () => {
    actions().closeAllFiles()

    expect(closeUnifiedTab).toHaveBeenCalledWith(editor.id)
    expect(closeUnifiedTab).not.toHaveBeenCalledWith(chat.id)
    expect(closeFile).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'retains pinned editors without prompting during Close All Editor Tabs (confirmation %s)',
    (confirmClosePinnedTab) => {
      setPinnedConfirmation(confirmClosePinnedTab)
      useAppStore.setState({
        unifiedTabsByWorktree: { [worktreeId]: [editor, pinnedEditor, chat] },
        openFiles: [
          makeOpenFile({ id: sharedFileId, worktreeId }),
          makeOpenFile({ id: 'pinned-file', worktreeId })
        ]
      })

      actions([editor, pinnedEditor, chat]).closeAllFiles()

      expect(closeUnifiedTab).toHaveBeenCalledWith(editor.id)
      expect(closeUnifiedTab).not.toHaveBeenCalledWith(pinnedEditor.id)
      expect(closeUnifiedTab).not.toHaveBeenCalledWith(chat.id)
      expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    }
  )

  it('keeps the confirmation policy for an explicit pinned editor close', () => {
    setPinnedConfirmation(true)
    useAppStore.setState({
      unifiedTabsByWorktree: { [worktreeId]: [pinnedEditor] },
      openFiles: [makeOpenFile({ id: 'pinned-file', worktreeId })]
    })

    actions([pinnedEditor]).closeFloatingItemConfirmed(pinnedEditor.id)

    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledOnce()
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    requestPinnedTabCloseConfirm.mock.calls[0]?.[0].onConfirm()
    expect(closeUnifiedTab).toHaveBeenCalledWith(pinnedEditor.id)
  })

  it('routes a dirty last reference through the shared save confirmation', () => {
    useAppStore.setState({
      unifiedTabsByWorktree: { [worktreeId]: [editor] },
      openFiles: [makeOpenFile({ id: sharedFileId, worktreeId, isDirty: true })]
    })

    actions().closeFloatingItemConfirmed(editor.id)

    expect(requestEditorFileClose).toHaveBeenCalledWith(sharedFileId, {
      onClosed: expect.any(Function)
    })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })
})
