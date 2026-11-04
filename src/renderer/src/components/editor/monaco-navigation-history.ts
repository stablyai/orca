import type { MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { setWithLRU } from '@/lib/scroll-cache'
import { assertEditorFileOperationCurrent } from '@/lib/editor-file-operation-owner'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { getEditorModelOwnerKey } from './model-lifetime/identity/editor-model-owner'
import { editorShortcutMatches } from './editor-shortcuts'
import { EditorNavigationHistory, type EditorNavigationLocation } from './editor-navigation-history'

const histories = new Map<string, EditorNavigationHistory>()
const editors = new Map<string, { editor: editor.IStandaloneCodeEditor; record: () => void }>()
let pendingRestore: EditorNavigationLocation | null = null

function historyFor(worktreeId: string): EditorNavigationHistory {
  const history = histories.get(worktreeId) ?? new EditorNavigationHistory()
  setWithLRU(histories, worktreeId, history)
  return history
}

function isCurrentRestore(location: EditorNavigationLocation): boolean {
  const state = useAppStore.getState()
  const tab = state.getActiveTab(location.file.worktreeId)
  const file = state.openFiles.find((candidate) => candidate.id === location.file.id)
  return (
    pendingRestore === location &&
    state.activeWorktreeId === location.file.worktreeId &&
    state.activeTabType === 'editor' &&
    state.activeFileId === location.file.id &&
    file !== undefined &&
    getEditorModelOwnerKey(file, state) === location.ownerKey &&
    (!location.tabId || tab?.id === location.tabId)
  )
}

function restoreLocation(location: EditorNavigationLocation): boolean {
  const state = useAppStore.getState()
  const { file } = location
  if (file.operationProvenance) {
    try {
      assertEditorFileOperationCurrent(state, file.worktreeId, file.operationProvenance)
    } catch {
      return false
    }
  }
  const existing = state.openFiles.find((candidate) => candidate.id === file.id)
  if (getEditorModelOwnerKey(existing ?? file, state) !== location.ownerKey) {
    return false
  }
  pendingRestore = location
  if (existing) {
    state.setActiveFile(existing.id, file.worktreeId)
    const tab = location.tabId ? state.getTab(location.tabId) : null
    if (tab?.entityId === existing.id) {
      state.activateTab(tab.id)
    } else {
      location.tabId = state.getActiveTab(file.worktreeId)?.id
      location.viewStateId = location.tabId ?? existing.id
    }
  } else {
    if (file.isUntitled || file.externalMutation === 'deleted') {
      pendingRestore = null
      return false
    }
    location.file = {
      ...file,
      id: state.openFile(
        {
          filePath: file.filePath,
          relativePath: file.relativePath,
          worktreeId: file.worktreeId,
          language: file.language,
          mode: 'edit',
          runtimeEnvironmentId: file.runtimeEnvironmentId,
          externalSshTargetId: file.externalSshTargetId,
          terminalArtifactGrantId: file.terminalArtifactGrantId,
          operationProvenance: file.operationProvenance,
          readOnly: file.readOnly
        },
        { preview: true }
      )
    }
    location.tabId = useAppStore.getState().getActiveTab(file.worktreeId)?.id
    location.viewStateId = location.tabId ?? location.file.id
  }
  state.setActiveTabType('editor', file.worktreeId)
  scheduleEditorLineReveal(
    useAppStore.getState,
    file.filePath,
    location.position.lineNumber,
    location.position.column,
    location.file.id,
    {
      viewStateId: location.viewStateId,
      canApply: () => isCurrentRestore(location),
      onApplied: () => {
        const mounted = editors.get(location.viewStateId ?? location.file.id)
        mounted?.editor.setScrollPosition({
          scrollTop: location.scrollTop,
          scrollLeft: location.scrollLeft
        })
        pendingRestore = null
        mounted?.record()
      }
    }
  )
  return true
}

function navigate(worktreeId: string, direction: 'back' | 'forward'): void {
  historyFor(worktreeId).step(direction, restoreLocation)
}

export function installMonacoNavigationHistory({
  editorInstance,
  fileIdRef,
  viewStateId,
  ownerKey
}: {
  editorInstance: editor.IStandaloneCodeEditor
  fileIdRef: MutableRefObject<string>
  viewStateId?: string
  ownerKey: string
}): () => void {
  const key = viewStateId ?? fileIdRef.current
  editors.set(key, { editor: editorInstance, record: () => record() })
  let lastLocation: EditorNavigationLocation | null = null

  const snapshot = (): EditorNavigationLocation | null => {
    const state = useAppStore.getState()
    const file = state.openFiles.find((candidate) => candidate.id === fileIdRef.current)
    const position = editorInstance.getPosition()
    if (!file || file.mode !== 'edit' || !position) {
      return null
    }
    if (
      state.activeWorktreeId !== file.worktreeId ||
      state.activeTabType !== 'editor' ||
      state.activeFileId !== file.id
    ) {
      return null
    }
    const tab = state.getActiveTab(file.worktreeId)
    if (
      (tab && tab.entityId !== file.id) ||
      (viewStateId && tab && viewStateId !== tab.id && viewStateId !== file.id)
    ) {
      return null
    }
    return {
      file,
      ownerKey,
      tabId: tab?.id,
      viewStateId,
      position,
      scrollTop: editorInstance.getScrollTop(),
      scrollLeft: editorInstance.getScrollLeft()
    }
  }

  const record = (explicitJump = false): void => {
    if (pendingRestore && isCurrentRestore(pendingRestore)) {
      return
    }
    pendingRestore = null
    const location = snapshot()
    if (location) {
      historyFor(location.file.worktreeId).record(location, explicitJump)
      lastLocation = location
    }
  }

  const update = (): void => {
    if (!lastLocation || pendingRestore) {
      return
    }
    const position = editorInstance.getPosition()
    if (position) {
      lastLocation = {
        ...lastLocation,
        position,
        scrollTop: editorInstance.getScrollTop(),
        scrollLeft: editorInstance.getScrollLeft()
      }
      historyFor(lastLocation.file.worktreeId).update(lastLocation)
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) {
      return
    }
    const direction = editorShortcutMatches('editor.navigateBack', event)
      ? 'back'
      : editorShortcutMatches('editor.navigateForward', event)
        ? 'forward'
        : null
    if (!direction) {
      pendingRestore = null
      return
    }
    const location = snapshot()
    if (!location) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) {
      update()
      navigate(location.file.worktreeId, direction)
    }
  }

  const subscriptions = [
    editorInstance.onDidFocusEditorWidget(() => record()),
    editorInstance.onDidBlurEditorWidget(update),
    editorInstance.onDidChangeCursorPosition((event) => {
      if (event.reason === 0 || event.reason === 3) {
        record(event.source === 'api' || event.source === 'gotoLocation')
      } else {
        update()
      }
    }),
    editorInstance.onDidScrollChange(update),
    editorInstance.onMouseDown(() => {
      pendingRestore = null
    })
  ]
  const container = editorInstance.getContainerDomNode()
  container.addEventListener('keydown', onKeyDown, true)
  return () => {
    update()
    subscriptions.forEach((subscription) => subscription.dispose())
    container.removeEventListener('keydown', onKeyDown, true)
    if (editors.get(key)?.editor === editorInstance) {
      editors.delete(key)
    }
  }
}
