import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { setWithLRU } from '@/lib/scroll-cache'
import { editorShortcutMatches } from './editor-shortcuts'
import { createEditorNavigationHistory } from './editor-navigation-history'
import {
  FILE_MODE,
  TAB_TYPE,
  ACTION,
  DIRECTION,
  EVENT,
  CURSOR_REASON,
  CURSOR_SOURCE
} from './editor-navigation.consts'
import type {
  History,
  Direction,
  EditorParams,
  Target,
  Location,
  RecordingState,
  Recorder
} from './editor-navigation.types'
import {
  canRestoreLocation,
  restoreLocation,
  isRestoring,
  cancelRestore,
  hasPendingRestore,
  registerEditor
} from './editor-navigation-restoration'

const histories = new Map<string, History>()

function historyFor(worktreeId: string): History {
  const history = histories.get(worktreeId) ?? createEditorNavigationHistory()
  setWithLRU(histories, worktreeId, history)

  return history
}

function navigate(worktreeId: string, direction: Direction): void {
  const history = historyFor(worktreeId)
  const location = history.step(direction, canRestoreLocation)
  if (location) {
    history.replaceCurrent(restoreLocation(location))
  }
}

function readActiveEditorTarget(params: EditorParams, state: AppState): Target | null {
  const file = state.openFiles.find((candidate) => candidate.id === params.fileIdRef.current)
  if (
    !file ||
    file.mode !== FILE_MODE ||
    state.activeWorktreeId !== file.worktreeId ||
    state.activeTabType !== TAB_TYPE ||
    state.activeFileId !== file.id
  ) {
    return null
  }

  const tab = state.getActiveTab(file.worktreeId)
  if (
    (tab && tab.entityId !== file.id) ||
    (params.viewStateId && tab && params.viewStateId !== tab.id && params.viewStateId !== file.id)
  ) {
    return null
  }

  return { file, tabId: tab?.id }
}

function readEditorViewport(editorInstance: editor.IStandaloneCodeEditor) {
  const position = editorInstance.getPosition()

  return position
    ? {
        position,
        scrollTop: editorInstance.getScrollTop(),
        scrollLeft: editorInstance.getScrollLeft()
      }
    : null
}

function readEditorLocation(params: EditorParams): Location | null {
  const target = readActiveEditorTarget(params, useAppStore.getState())
  const viewport = readEditorViewport(params.editorInstance)
  if (!target || !viewport) {
    return null
  }

  return { ...target, ...viewport, ownerKey: params.ownerKey, viewStateId: params.viewStateId }
}

function recordEditorLocation(
  params: EditorParams,
  recording: RecordingState,
  explicitJump: boolean
): void {
  if (isRestoring()) {
    return
  }

  cancelRestore()
  const location = readEditorLocation(params)
  if (!location) {
    return
  }

  historyFor(location.file.worktreeId).record(location, explicitJump)
  recording.location = location
}

function updateEditorLocation(params: EditorParams, recording: RecordingState): void {
  const previous = recording.location
  if (!previous || hasPendingRestore()) {
    return
  }

  const viewport = readEditorViewport(params.editorInstance)
  if (!viewport) {
    return
  }

  const location = { ...previous, ...viewport }
  recording.location = location
  historyFor(location.file.worktreeId).update(location)
}

function createNavigationRecorder(params: EditorParams): Recorder {
  const recording: RecordingState = { location: null }

  return {
    snapshot: () => readEditorLocation(params),
    record: (explicitJump = false) => recordEditorLocation(params, recording, explicitJump),
    update: () => updateEditorLocation(params, recording)
  }
}

function navigationDirection(event: KeyboardEvent): Direction | null {
  if (editorShortcutMatches(ACTION.BACK, event)) {
    return DIRECTION.BACK
  }

  if (editorShortcutMatches(ACTION.FORWARD, event)) {
    return DIRECTION.FORWARD
  }

  return null
}

function handleNavigationKey(event: KeyboardEvent, recorder: Recorder): void {
  if (event.defaultPrevented || event.isComposing) {
    return
  }

  const direction = navigationDirection(event)
  if (!direction) {
    cancelRestore()

    return
  }

  const location = recorder.snapshot()
  if (!location) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) {
    recorder.update()
    navigate(location.file.worktreeId, direction)
  }
}

function installNavigationKeyboard(
  editorInstance: editor.IStandaloneCodeEditor,
  recorder: Recorder
): () => void {
  const container = editorInstance.getContainerDomNode()
  const onKeyDown = (event: KeyboardEvent): void => handleNavigationKey(event, recorder)
  container.addEventListener(EVENT.KEY_DOWN, onKeyDown, true)

  return () => container.removeEventListener(EVENT.KEY_DOWN, onKeyDown, true)
}

function subscribeNavigationEvents(
  editorInstance: editor.IStandaloneCodeEditor,
  recorder: Recorder
): () => void {
  const subscriptions = [
    editorInstance.onDidFocusEditorWidget(() => recorder.record()),
    editorInstance.onDidBlurEditorWidget(recorder.update),
    editorInstance.onDidChangeCursorPosition((event) => {
      if (event.reason === CURSOR_REASON.NOT_SET || event.reason === CURSOR_REASON.EXPLICIT) {
        recorder.record(
          event.source === CURSOR_SOURCE.API || event.source === CURSOR_SOURCE.GOTO_LOCATION
        )
      } else {
        recorder.update()
      }
    }),
    editorInstance.onDidScrollChange(recorder.update),
    editorInstance.onMouseDown(cancelRestore)
  ]

  return () => subscriptions.forEach((subscription) => subscription.dispose())
}

export function installMonacoNavigationHistory(params: EditorParams): () => void {
  const recorder = createNavigationRecorder(params)
  const key = params.viewStateId ?? params.fileIdRef.current
  const unregisterEditor = registerEditor(key, {
    editor: params.editorInstance,
    record: recorder.record
  })
  const disposeKeyboard = installNavigationKeyboard(params.editorInstance, recorder)
  const disposeEvents = subscribeNavigationEvents(params.editorInstance, recorder)

  return () => {
    recorder.update()
    disposeEvents()
    disposeKeyboard()
    unregisterEditor()
  }
}
