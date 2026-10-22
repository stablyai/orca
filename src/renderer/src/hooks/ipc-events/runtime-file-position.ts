import type { RuntimeFileOpenPosition } from '../../../../shared/runtime-file-contracts'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { selectFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import {
  isEventTargetInsideFloatingWorkspacePanel,
  isFloatingWorkspacePanelFocused
} from '@/lib/floating-workspace-terminal-actions'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'

function selectedEditorTab(state: AppState, worktreeId = state.activeWorktreeId) {
  if (
    !worktreeId ||
    (worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      ? !selectFloatingWorkspacePanelVisible(state)
      : worktreeId !== state.activeWorktreeId)
  ) {
    return undefined
  }
  const group = state.groupsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === state.activeGroupIdByWorktree[worktreeId]
  )
  return state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.id === group?.activeTabId && tab.contentType === 'editor'
  )
}

export function createRuntimeFilePositionQueue(
  unsubs: (() => void)[]
): (fileId: string, position: RuntimeFileOpenPosition | undefined, focus: boolean) => void {
  let alive = true
  type Request = {
    position: RuntimeFileOpenPosition
    waitingForFloatingFocus: boolean
  }
  const pending = new Map<string, Request>()

  const reveal = (fileId: string, request: Request): void => {
    const { position } = request
    const store = useAppStore.getState()
    const file = store.openFiles.find((candidate) => candidate.id === fileId)
    const tab = file && selectedEditorTab(store, file.worktreeId)
    if (!file || !tab || tab.entityId !== fileId || request.waitingForFloatingFocus) {
      return
    }
    const canApply = (): boolean =>
      alive &&
      pending.get(fileId) === request &&
      !request.waitingForFloatingFocus &&
      (file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
        useAppStore.getState().activeWorktreeId === store.activeWorktreeId) &&
      selectedEditorTab(useAppStore.getState(), file.worktreeId)?.id === tab.id
    scheduleEditorLineReveal(
      useAppStore.getState,
      file.filePath,
      position.line,
      position.column,
      fileId,
      {
        viewStateId: tab.id,
        canApply,
        beforePublish: () => {
          if (file.language === 'markdown') {
            useAppStore.getState().setMarkdownViewMode(fileId, 'source')
          }
        },
        onApplied: () => {
          if (pending.get(fileId) === request) {
            pending.delete(fileId)
          }
        }
      }
    )
  }

  if (typeof document !== 'undefined') {
    const handleFloatingFocus = (event: Event): void => {
      if (pending.size === 0) {
        return
      }
      const state = useAppStore.getState()
      if (!isEventTargetInsideFloatingWorkspacePanel(event.target)) {
        for (const file of state.openFiles) {
          if (file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
            const request = pending.get(file.id)
            if (request) {
              request.waitingForFloatingFocus = true
            }
          }
        }
        return
      }
      const tab = selectedEditorTab(state, FLOATING_TERMINAL_WORKTREE_ID)
      const request = tab && pending.get(tab.entityId)
      if (tab && request?.waitingForFloatingFocus) {
        request.waitingForFloatingFocus = false
        reveal(tab.entityId, request)
      }
    }
    document.addEventListener('focusin', handleFloatingFocus)
    document.addEventListener('pointerdown', handleFloatingFocus, true)
    unsubs.push(() => {
      document.removeEventListener('focusin', handleFloatingFocus)
      document.removeEventListener('pointerdown', handleFloatingFocus, true)
    })
  }

  unsubs.push(
    useAppStore.subscribe((state, previous) => {
      if (pending.size === 0) {
        return
      }
      if (state.openFiles !== previous.openFiles) {
        const openIds = new Set(state.openFiles.map((file) => file.id))
        for (const fileId of pending.keys()) {
          if (!openIds.has(fileId)) {
            pending.delete(fileId)
          }
        }
      }
      if (
        state.activeWorktreeId === previous.activeWorktreeId &&
        state.groupsByWorktree === previous.groupsByWorktree &&
        state.activeGroupIdByWorktree === previous.activeGroupIdByWorktree &&
        selectFloatingWorkspacePanelVisible(state) === selectFloatingWorkspacePanelVisible(previous)
      ) {
        return
      }
      for (const worktreeId of new Set([state.activeWorktreeId, FLOATING_TERMINAL_WORKTREE_ID])) {
        const tab = selectedEditorTab(state, worktreeId)
        // A background open must wait for navigation, even if this file is already on screen.
        if (
          !tab ||
          (tab.id === selectedEditorTab(previous, worktreeId)?.id &&
            (worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
              state.activeWorktreeId === previous.activeWorktreeId))
        ) {
          continue
        }
        const request = pending.get(tab.entityId)
        if (request) {
          if (
            worktreeId === FLOATING_TERMINAL_WORKTREE_ID &&
            typeof document !== 'undefined' &&
            isFloatingWorkspacePanelFocused()
          ) {
            request.waitingForFloatingFocus = false
          }
          reveal(tab.entityId, request)
        }
      }
    }),
    () => {
      alive = false
      pending.clear()
    }
  )

  return (fileId, position, focus) => {
    if (!position) {
      pending.delete(fileId)
      return
    }
    const request = {
      position,
      waitingForFloatingFocus:
        !focus &&
        useAppStore
          .getState()
          .openFiles.some(
            (file) => file.id === fileId && file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID
          )
    }
    pending.set(fileId, request)
    if (focus) {
      reveal(fileId, request)
    }
  }
}
