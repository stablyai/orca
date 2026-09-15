import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { installMonacoDiffChangeNavigationShortcut } from './editor-shortcuts'
import type { WorktreeDiffNavigationDirection } from './worktree-diff-file-navigation'

export type DiffEditorRegistrationContextValue = {
  registerDiffEditor: (editor: editor.IStandaloneDiffEditor) => void
  unregisterDiffEditor: (editor: editor.IStandaloneDiffEditor) => void
}

export type DiffNavigationContextValue = {
  goToPreviousDiff: () => void
  goToNextDiff: () => void
  changeCount: number
  canNavigate: boolean
}

type DiffNavigationProviderProps = {
  children: React.ReactNode
  canNavigateFile?: boolean
  onNavigateFile?: (direction: WorktreeDiffNavigationDirection) => boolean
}

type DiffLineChange = NonNullable<ReturnType<editor.IStandaloneDiffEditor['getLineChanges']>>[number]
type LastInFileNavigation = {
  editor: editor.IStandaloneDiffEditor
  direction: WorktreeDiffNavigationDirection
  lineNumber: number
}

const noop = (): void => {}

// Why: registration stays separate from changeCount so diff recomputation only
// rerenders the header controls, not the heavy Monaco DiffViewer consumer.
const DiffEditorRegistrationContext = createContext<DiffEditorRegistrationContextValue>({
  registerDiffEditor: noop,
  unregisterDiffEditor: noop
})

const DiffNavigationContext = createContext<DiffNavigationContextValue>({
  goToPreviousDiff: noop,
  goToNextDiff: noop,
  changeCount: 0,
  canNavigate: false
})

function countChanges(diffEditor: editor.IStandaloneDiffEditor): number {
  return diffEditor.getLineChanges()?.length ?? 0
}

function getModifiedStartLine(change: DiffLineChange): number {
  return change.modifiedStartLineNumber || change.modifiedEndLineNumber
}

function getModifiedEndLine(change: DiffLineChange): number {
  return change.modifiedEndLineNumber || change.modifiedStartLineNumber
}

function getRemainingChangeLine(
  diffEditor: editor.IStandaloneDiffEditor,
  direction: WorktreeDiffNavigationDirection,
  lastNavigation: LastInFileNavigation | null
): number | null {
  const changes = diffEditor.getLineChanges() ?? []
  if (changes.length === 0) {
    return null
  }
  const positionLineNumber = diffEditor.getModifiedEditor().getPosition()?.lineNumber ?? null
  const lineNumber = getEffectiveLineNumber(
    diffEditor,
    direction,
    positionLineNumber,
    lastNavigation
  )
  if (lineNumber === null) {
    const edgeChange = direction === 'next' ? changes[0] : changes.at(-1)
    return edgeChange ? getChangeLine(edgeChange, direction) : null
  }
  if (direction === 'next') {
    return changes
      .map((change) => getModifiedStartLine(change))
      .find((changeLine) => changeLine > lineNumber) ?? null
  }
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const changeLine = getModifiedEndLine(changes[index])
    if (changeLine < lineNumber) {
      return changeLine
    }
  }
  return null
}

function getEffectiveLineNumber(
  diffEditor: editor.IStandaloneDiffEditor,
  direction: WorktreeDiffNavigationDirection,
  positionLineNumber: number | null,
  lastNavigation: LastInFileNavigation | null
): number | null {
  if (lastNavigation?.editor !== diffEditor || lastNavigation.direction !== direction) {
    return positionLineNumber
  }
  if (positionLineNumber === null) {
    return lastNavigation.lineNumber
  }
  if (direction === 'next' && positionLineNumber <= lastNavigation.lineNumber) {
    return lastNavigation.lineNumber
  }
  if (direction === 'previous' && positionLineNumber >= lastNavigation.lineNumber) {
    return lastNavigation.lineNumber
  }
  return positionLineNumber
}

function getChangeLine(
  change: DiffLineChange,
  direction: WorktreeDiffNavigationDirection
): number {
  return direction === 'next' ? getModifiedStartLine(change) : getModifiedEndLine(change)
}

export function DiffNavigationProvider({
  children,
  canNavigateFile = false,
  onNavigateFile
}: DiffNavigationProviderProps): React.JSX.Element {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const updateSubRef = useRef<{ dispose: () => void } | null>(null)
  const canNavigateFileRef = useRef(canNavigateFile)
  const onNavigateFileRef = useRef<typeof onNavigateFile>(onNavigateFile)
  const pendingRevealDirectionRef = useRef<WorktreeDiffNavigationDirection | null>(null)
  const lastInFileNavigationRef = useRef<LastInFileNavigation | null>(null)
  // Why: F7/Shift+F7 change navigation shares the registered editor with the
  // header buttons, so the keyboard listener lives here rather than in DiffViewer.
  const shortcutCleanupRef = useRef<(() => void) | null>(null)
  // Why: changeCount must be state, not a ref — the header is a sibling consumer
  // and only re-renders (enabling the buttons) when the value object identity
  // changes on the 0 -> N flip once the diff computation lands.
  const [changeCount, setChangeCount] = useState(0)

  canNavigateFileRef.current = canNavigateFile
  onNavigateFileRef.current = onNavigateFile

  const revealPendingDiff = useCallback((diffEditor: editor.IStandaloneDiffEditor) => {
    const direction = pendingRevealDirectionRef.current
    if (!direction) {
      return
    }
    pendingRevealDirectionRef.current = null
    if (countChanges(diffEditor) > 0) {
      diffEditor.goToDiff(direction)
    }
  }, [])

  const navigate = useCallback((direction: WorktreeDiffNavigationDirection): void => {
    const diffEditor = editorRef.current
    if (diffEditor) {
      const lineNumber = getRemainingChangeLine(
        diffEditor,
        direction,
        lastInFileNavigationRef.current
      )
      if (lineNumber !== null) {
        lastInFileNavigationRef.current = { editor: diffEditor, direction, lineNumber }
        diffEditor.goToDiff(direction)
        return
      }
    }
    lastInFileNavigationRef.current = null
    if (!canNavigateFileRef.current || !onNavigateFileRef.current?.(direction)) {
      return
    }
    pendingRevealDirectionRef.current = direction
  }, [])

  const registerDiffEditor = useCallback(
    (diffEditor: editor.IStandaloneDiffEditor) => {
      editorRef.current = diffEditor
      lastInFileNavigationRef.current = null
      // Hold at most one update subscription; replace any prior editor's.
      updateSubRef.current?.dispose()
      updateSubRef.current = diffEditor.onDidUpdateDiff(() => {
        // Why: ignore updates from an editor that is no longer current so a stale
        // subscription in the fast-swap case can't write a wrong count.
        if (editorRef.current === diffEditor) {
          setChangeCount(countChanges(diffEditor))
          revealPendingDiff(diffEditor)
        }
      })
      // Hold at most one keyboard listener; replace any prior editor's.
      shortcutCleanupRef.current?.()
      shortcutCleanupRef.current = installMonacoDiffChangeNavigationShortcut({
        getContainerDomNode: () => diffEditor.getContainerDomNode(),
        navigate
      })
      const initialChangeCount = countChanges(diffEditor)
      setChangeCount(initialChangeCount)
      if (initialChangeCount > 0) {
        revealPendingDiff(diffEditor)
      }
    },
    [navigate, revealPendingDiff]
  )

  const unregisterDiffEditor = useCallback((diffEditor: editor.IStandaloneDiffEditor) => {
    // Why: identity guard for the fast-swap race — a stale dispose carrying the
    // old editor must not wipe a freshly-registered new one.
    if (editorRef.current !== diffEditor) {
      return
    }
    updateSubRef.current?.dispose()
    updateSubRef.current = null
    shortcutCleanupRef.current?.()
    shortcutCleanupRef.current = null
    editorRef.current = null
    setChangeCount(0)
  }, [])

  const goToPreviousDiff = useCallback(() => {
    navigate('previous')
  }, [navigate])

  const goToNextDiff = useCallback(() => {
    navigate('next')
  }, [navigate])

  useEffect(() => {
    return () => {
      updateSubRef.current?.dispose()
      updateSubRef.current = null
      shortcutCleanupRef.current?.()
      shortcutCleanupRef.current = null
      pendingRevealDirectionRef.current = null
      lastInFileNavigationRef.current = null
    }
  }, [])

  const registrationValue = useMemo(
    () => ({ registerDiffEditor, unregisterDiffEditor }),
    [registerDiffEditor, unregisterDiffEditor]
  )
  const canNavigate = changeCount > 0 || canNavigateFile
  const navigationValue = useMemo(
    () => ({
      goToPreviousDiff,
      goToNextDiff,
      changeCount,
      canNavigate
    }),
    [goToPreviousDiff, goToNextDiff, changeCount, canNavigate]
  )

  return (
    <DiffEditorRegistrationContext.Provider value={registrationValue}>
      <DiffNavigationContext.Provider value={navigationValue}>
        {children}
      </DiffNavigationContext.Provider>
    </DiffEditorRegistrationContext.Provider>
  )
}

export function useDiffEditorRegistration(): DiffEditorRegistrationContextValue {
  return useContext(DiffEditorRegistrationContext)
}

export function useDiffNavigation(): DiffNavigationContextValue {
  return useContext(DiffNavigationContext)
}
