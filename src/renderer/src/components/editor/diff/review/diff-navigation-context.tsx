import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { installMonacoDiffChangeNavigationShortcut } from '../../commands/editor-shortcuts'
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
  /** Whether F7/Shift+F7 can cross into an adjacent worktree file at the change boundary. */
  canNavigateFile?: boolean
  onNavigateFile?: (direction: WorktreeDiffNavigationDirection) => boolean
  /** Direction of the pending cross-file arrival; explicit null once the pane shows another file so a stale reveal cannot fire. Omit when the pane does not track arrivals. */
  arrivalReveal?: WorktreeDiffNavigationDirection | null
}

type DiffLineChange = NonNullable<
  ReturnType<editor.IStandaloneDiffEditor['getLineChanges']>
>[number]

const noop = (): void => {}

// Separate registration from counts so diff recomputation rerenders header controls without waking Monaco consumers.
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

// goToDiff reveals mapping.modified.startLineNumber; pure deletions report that anchor minus one through the deprecated getLineChanges.
function getRevealedChangeLine(change: DiffLineChange): number {
  return change.modifiedEndLineNumber === 0
    ? change.modifiedStartLineNumber + 1
    : change.modifiedStartLineNumber
}

function hasRemainingChange(
  diffEditor: editor.IStandaloneDiffEditor,
  direction: WorktreeDiffNavigationDirection
): boolean {
  const changes = diffEditor.getLineChanges() ?? []
  if (changes.length === 0) {
    return false
  }
  const modifiedEditor = diffEditor.getModifiedEditor()
  const currentLine = modifiedEditor.getPosition()?.lineNumber ?? 1
  if (direction === 'next') {
    // Why >=: at the modified file's last line goToDiff always wraps to the first change, so the file is exhausted.
    const lineCount = modifiedEditor.getModel()?.getLineCount() ?? currentLine
    return (
      currentLine < lineCount &&
      changes.some((change) => getRevealedChangeLine(change) > currentLine)
    )
  }
  return changes.some((change) => getRevealedChangeLine(change) < currentLine)
}

export function DiffNavigationProvider({
  children,
  canNavigateFile = false,
  onNavigateFile,
  arrivalReveal
}: DiffNavigationProviderProps): React.JSX.Element {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const updateSubRef = useRef<{ dispose: () => void } | null>(null)
  // Share the registered editor across header buttons and F7/Shift+F7 shortcuts.
  const shortcutCleanupRef = useRef<(() => void) | null>(null)
  const canNavigateFileRef = useRef(canNavigateFile)
  const onNavigateFileRef = useRef(onNavigateFile)
  const pendingRevealDirectionRef = useRef<WorktreeDiffNavigationDirection | null>(null)
  // Use state so sibling header controls repaint when diff computation changes their enabled state.
  const [changeCount, setChangeCount] = useState(0)

  // Navigate runs from event handlers after commit, so effect-time sync keeps the refs current.
  useEffect(() => {
    canNavigateFileRef.current = canNavigateFile
    onNavigateFileRef.current = onNavigateFile
  }, [canNavigateFile, onNavigateFile])
  // A hop whose target never mounts a diff editor must not arm a later, unrelated editor's reveal.
  // Why effect: child registrations fire before parent effects, but a fresh mount never has a
  // computed diff at registration, so the disarm lands before the first onDidUpdateDiff reveal.
  useEffect(() => {
    if (arrivalReveal === null) {
      pendingRevealDirectionRef.current = null
    }
  }, [arrivalReveal])

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
    if (diffEditor && hasRemainingChange(diffEditor, direction)) {
      diffEditor.goToDiff(direction)
      return
    }
    const didNavigateFile =
      canNavigateFileRef.current && onNavigateFileRef.current?.(direction) === true
    if (!didNavigateFile) {
      // Keep the same-file wrap when the worktree file sweep cannot run.
      diffEditor?.goToDiff(direction)
      return
    }
    pendingRevealDirectionRef.current = direction
  }, [])

  const registerDiffEditor = useCallback(
    (diffEditor: editor.IStandaloneDiffEditor) => {
      editorRef.current = diffEditor
      // Hold at most one update subscription; replace any prior editor's.
      updateSubRef.current?.dispose()
      updateSubRef.current = diffEditor.onDidUpdateDiff(() => {
        // Ignore stale editor callbacks after a fast registration swap.
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
    // A stale disposal must not clear a newly registered replacement editor.
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
