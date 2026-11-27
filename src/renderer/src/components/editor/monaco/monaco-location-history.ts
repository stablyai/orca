import type { editor, IPosition } from 'monaco-editor'
import { assertEditorFileOperationCurrent } from '@/lib/editor/file-operations/editor-file-operation-provenance'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { useAppStore } from '@/store'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { editorShortcutMatches } from '../commands/editor-shortcuts'

type Location = {
  file: OpenFile
  viewId: string
  position: IPosition
  scrollTop: number
  scrollLeft: number
}

type History = {
  entries: Location[]
  index: number
  restoring?: Location
}

const histories = new Map<string, History>()
const mountedEditors = new Map<string, editor.IStandaloneCodeEditor>()
const MAX_WORKSPACES = 30
const MAX_LOCATIONS = 100
const CURSOR_JUMP_LINES = 10

function getWorkspaceHistory(worktreeId: string): History {
  const existing = histories.get(worktreeId)
  if (existing) {
    return existing
  }

  if (histories.size >= MAX_WORKSPACES) {
    const oldest = histories.keys().next().value
    if (oldest !== undefined) {
      histories.delete(oldest)
    }
  }
  const history = { entries: [], index: -1 }
  histories.set(worktreeId, history)
  return history
}

function recordLocation(history: History, location: Location, jump: boolean): void {
  const current = history.entries[history.index]
  if (current?.viewId === location.viewId && current.file.id === location.file.id && !jump) {
    history.entries[history.index] = location
    return
  }
  history.entries = [...history.entries.slice(0, history.index + 1), location].slice(-MAX_LOCATIONS)
  history.index = history.entries.length - 1
}

function canReopen(file: OpenFile): boolean {
  if (
    file.mode !== 'edit' ||
    file.isUntitled ||
    file.externalMutation ||
    file.pendingOwnerMigration ||
    !file.operationProvenance
  ) {
    return false
  }
  try {
    assertEditorFileOperationCurrent(
      useAppStore.getState(),
      file.worktreeId,
      file.operationProvenance
    )
    return true
  } catch {
    return false
  }
}

function revealLocation(worktreeId: string, history: History, location: Location): void {
  scheduleEditorLineReveal(
    useAppStore.getState,
    location.file.filePath,
    location.position.lineNumber,
    location.position.column,
    location.file.id,
    {
      viewStateId: location.viewId,
      canApply: () => {
        const state = useAppStore.getState()
        return (
          history.restoring === location &&
          state.activeWorktreeId === worktreeId &&
          state.getActiveTab(worktreeId)?.id === location.viewId
        )
      },
      onApplied: () => {
        if (history.restoring === location) {
          mountedEditors.get(location.viewId)?.setScrollPosition({
            scrollTop: location.scrollTop,
            scrollLeft: location.scrollLeft
          })
          history.restoring = undefined
        }
      },
      onDropped: () => {
        if (history.restoring === location) {
          history.restoring = undefined
        }
      }
    }
  )
}

export function installMonacoLocationHistory(
  instance: editor.IStandaloneCodeEditor,
  explicitCursorChange: number,
  worktreeId: string,
  viewId: string,
  getFileId: () => string
): void {
  const target = instance.getContainerDomNode()
  mountedEditors.set(viewId, instance)
  const isSelected = (): boolean => {
    const state = useAppStore.getState()
    return state.activeWorktreeId === worktreeId && state.getActiveTab(worktreeId)?.id === viewId
  }
  const snapshot = (): Location | undefined => {
    const position = instance.getPosition()
    const fileId = getFileId()
    const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === fileId)
    if (file && position) {
      return {
        file,
        viewId,
        position,
        scrollTop: instance.getScrollTop(),
        scrollLeft: instance.getScrollLeft()
      }
    }
    return undefined
  }
  const record = (jump = false): void => {
    if (!isSelected()) {
      return
    }
    const history = getWorkspaceHistory(worktreeId)
    const location = snapshot()
    if (!location || history.restoring?.viewId === viewId) {
      return
    }
    history.restoring = undefined
    recordLocation(history, location, jump)
  }

  const navigate = (direction: -1 | 1): void => {
    const history = getWorkspaceHistory(worktreeId)
    if (!history.restoring) {
      record()
    }
    const state = useAppStore.getState()
    for (
      let index = history.index + direction;
      index >= 0 && index < history.entries.length;
      index += direction
    ) {
      const location = history.entries[index]
      const tab = state.getTab(location.viewId)
      const file = state.openFiles.find((candidate) => candidate.id === location.file.id)
      const source = state.getActiveTab(worktreeId)
      const canActivate =
        tab?.entityId === location.file.id && file?.filePath === location.file.filePath
      const reopen = file ?? location.file
      if (!canActivate && (!source || !canReopen(reopen))) {
        continue
      }

      const previousIndex = history.index
      history.index = index
      history.restoring = location
      if (canActivate) {
        state.activateTab(tab.id, { worktreeId, preservePreview: true })
        revealLocation(worktreeId, history, location)
      } else if (source) {
        const {
          filePath,
          relativePath,
          language,
          runtimeEnvironmentId,
          externalSshTargetId,
          terminalArtifactGrantId,
          operationProvenance,
          readOnly
        } = reopen
        state.openFileForLink(
          {
            filePath,
            relativePath,
            language,
            runtimeEnvironmentId,
            externalSshTargetId,
            terminalArtifactGrantId,
            operationProvenance,
            readOnly,
            worktreeId,
            mode: 'edit'
          },
          { preview: false },
          {
            sourceTabId: source.id,
            targetGroupId: source.groupId,
            workspaceId: worktreeId,
            hostId: source.executionHostId ?? null
          },
          (shown) => {
            if (history.restoring !== location) {
              return
            }
            const current = useAppStore.getState()
            const opened = current.openFiles.find((candidate) => candidate.id === shown?.fileId)
            if (!shown || !opened || current.getActiveTab(worktreeId)?.id !== shown.viewStateId) {
              // Why: a stale entry would keep winning Back and hide older valid locations.
              history.entries.splice(index, 1)
              history.index = index < previousIndex ? previousIndex - 1 : previousIndex
              history.restoring = undefined
              return
            }
            const resolved = { ...location, file: opened, viewId: shown.viewStateId }
            history.entries[index] = resolved
            history.restoring = resolved
            revealLocation(worktreeId, history, resolved)
          }
        )
      }
      return
    }
  }

  const keyDown = (event: KeyboardEvent): void => {
    if (!instance.hasTextFocus() || !isSelected()) {
      return
    }
    const back = editorShortcutMatches('editor.navigateBack', event)
    if (!back && !editorShortcutMatches('editor.navigateForward', event)) {
      if (event.key.length === 1 || event.key.startsWith('Arrow')) {
        getWorkspaceHistory(worktreeId).restoring = undefined
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) {
      navigate(back ? -1 : 1)
    }
  }
  const mouseButton = (event: MouseEvent): void => {
    if ((event.button !== 3 && event.button !== 4) || !isSelected()) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'mouseup') {
      navigate(event.button === 3 ? -1 : 1)
    }
  }
  const focus = instance.onDidFocusEditorText(() => record())
  const openingReveal = useAppStore.getState().pendingEditorReveal
  let previousPosition = instance.getPosition()
  const cursor = instance.onDidChangeCursorPosition((event) => {
    const previous = previousPosition
    previousPosition = event.position
    const commandJump = event.source === 'api' || event.source === 'gotoLocation'
    if (instance.hasTextFocus() || commandJump) {
      const longJump =
        previous !== null &&
        Math.abs(event.position.lineNumber - previous.lineNumber) >= CURSOR_JUMP_LINES
      const reveal = useAppStore.getState().pendingEditorReveal
      const revealedHere =
        commandJump &&
        reveal !== null &&
        (reveal.fileId === getFileId() || reveal.filePath === instance.getModel()?.uri.path)
      record(
        (event.source === 'gotoLocation' ||
          revealedHere ||
          ((commandJump || event.reason === explicitCursorChange) && longJump)) &&
          !(revealedHere && reveal === openingReveal)
      )
    }
  })
  record()
  const scroll = instance.onDidScrollChange(() => {
    const history = getWorkspaceHistory(worktreeId)
    const location = history.entries[history.index]
    if (isSelected() && location?.viewId === viewId && !history.restoring) {
      location.scrollTop = instance.getScrollTop()
      location.scrollLeft = instance.getScrollLeft()
    }
  })

  target.addEventListener('keydown', keyDown, true)
  target.addEventListener('mousedown', mouseButton, true)
  target.addEventListener('mouseup', mouseButton, true)
  target.addEventListener('auxclick', mouseButton, true)
  instance.onDidDispose(() => {
    if (mountedEditors.get(viewId) === instance) {
      mountedEditors.delete(viewId)
    }
    focus.dispose()
    cursor.dispose()
    scroll.dispose()
    target.removeEventListener('keydown', keyDown, true)
    target.removeEventListener('mousedown', mouseButton, true)
    target.removeEventListener('mouseup', mouseButton, true)
    target.removeEventListener('auxclick', mouseButton, true)
  })
}
