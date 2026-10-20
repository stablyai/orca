import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MutableRefObject
} from 'react'
import { registerPendingEditorFlush } from './editor-pending-flush'
import {
  deleteIpynbCell,
  insertIpynbCell,
  moveIpynbCell,
  updateIpynbCellKind,
  updateIpynbCellSources
} from './ipynb-cell-mutations'
import { parseIpynb, type IpynbCell, type IpynbCellKind, type ParsedIpynb } from './ipynb-parse'

const NOTEBOOK_SOURCE_COMMIT_DELAY_MS = 400

function parseOrNull(content: string): ParsedIpynb | null {
  try {
    return parseIpynb(content)
  } catch {
    return null
  }
}

export function getIpynbCellKey(cell: IpynbCell, index: number): string {
  return cell.id ?? `${index}:${cell.kind}`
}

export function hasIpynbSourceDraft(drafts: Record<string, string>, key: string): boolean {
  return Object.hasOwn(drafts, key)
}

function cancelStructuralFrames(frameIds: MutableRefObject<number[]>): void {
  for (const frameId of frameIds.current) {
    cancelAnimationFrame(frameId)
  }
  frameIds.current = []
}

function requestStructuralFrame(
  frameIds: MutableRefObject<number[]>,
  callback: FrameRequestCallback
): void {
  let completed = false
  let frameId: number | undefined
  frameId = requestAnimationFrame((timestamp) => {
    completed = true
    if (frameId !== undefined) {
      frameIds.current = frameIds.current.filter((pendingFrameId) => pendingFrameId !== frameId)
    }
    callback(timestamp)
  })
  if (!completed) {
    frameIds.current.push(frameId)
  }
}

type UseIpynbDocumentEditingArgs = {
  content: string
  fileId: string
  notebook: ParsedIpynb | null
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onDeactivateEditor: () => void
  /** The file's shared unsaved text, which may be newer than `content` when another tab commits. */
  readSharedContent?: () => string | undefined
}

export function useIpynbDocumentEditing({
  content,
  fileId,
  notebook,
  onContentChange,
  onDirtyStateHint,
  onDeactivateEditor,
  readSharedContent
}: UseIpynbDocumentEditingArgs) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, string>>({})
  const sourceDraftsRef = useRef(sourceDrafts)
  const contentRef = useRef(content)
  const notebookRef = useRef(notebook)
  const onContentChangeRef = useRef(onContentChange)
  const onDirtyStateHintRef = useRef(onDirtyStateHint)
  const sourceCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const structuralFrameIdsRef = useRef<number[]>([])
  const readSharedContentRef = useRef(readSharedContent)
  useLayoutEffect(() => {
    contentRef.current = content
    notebookRef.current = notebook
    onContentChangeRef.current = onContentChange
    onDirtyStateHintRef.current = onDirtyStateHint
    readSharedContentRef.current = readSharedContent
  }, [content, notebook, onContentChange, onDirtyStateHint, readSharedContent])

  // Why the shared draft: another tab of this notebook may have committed other cells since this
  // one rendered; this tab's cell edits apply onto that text, matched by cell, not over it.
  const latestSharedContent = useCallback(
    (): string => readSharedContentRef.current?.() ?? contentRef.current,
    []
  )

  const materializeSourceDrafts = useCallback((): string => {
    const base = latestSharedContent()
    const drafts = sourceDraftsRef.current
    if (Object.keys(drafts).length === 0) {
      return base
    }
    const latestNotebook = base === contentRef.current ? notebookRef.current : parseOrNull(base)
    if (!latestNotebook) {
      return base
    }
    const updates = latestNotebook.cells
      .map((cell, index) => {
        const key = getIpynbCellKey(cell, index)
        return hasIpynbSourceDraft(drafts, key) ? { index, source: drafts[key] ?? '' } : null
      })
      .filter((update): update is { index: number; source: string } => update !== null)
    return updateIpynbCellSources(base, updates)
  }, [latestSharedContent])

  const flushSourceDrafts = useCallback((): string => {
    if (sourceCommitTimerRef.current !== null) {
      clearTimeout(sourceCommitTimerRef.current)
      sourceCommitTimerRef.current = null
    }
    const base = latestSharedContent()
    const nextContent = materializeSourceDrafts()
    if (nextContent !== base || nextContent !== contentRef.current) {
      contentRef.current = nextContent
      onContentChangeRef.current(nextContent)
    }
    return nextContent
  }, [latestSharedContent, materializeSourceDrafts])

  const queueSourceDraftCommit = useCallback((): void => {
    if (sourceCommitTimerRef.current !== null) {
      clearTimeout(sourceCommitTimerRef.current)
    }
    sourceCommitTimerRef.current = setTimeout(() => {
      void flushSourceDrafts()
    }, NOTEBOOK_SOURCE_COMMIT_DELAY_MS)
  }, [flushSourceDrafts])

  useEffect(
    () => registerPendingEditorFlush(fileId, flushSourceDrafts),
    [fileId, flushSourceDrafts]
  )

  useEffect(() => {
    if (!notebook || Object.keys(sourceDraftsRef.current).length === 0) {
      return
    }
    const nextDrafts = { ...sourceDraftsRef.current }
    let changed = false
    for (const [index, cell] of notebook.cells.entries()) {
      const key = getIpynbCellKey(cell, index)
      if (hasIpynbSourceDraft(nextDrafts, key) && nextDrafts[key] === cell.source) {
        delete nextDrafts[key]
        changed = true
      }
    }
    if (changed) {
      sourceDraftsRef.current = nextDrafts
      setSourceDrafts(nextDrafts)
    }
  }, [notebook])

  const setRootRef = useCallback(
    (node: HTMLDivElement | null): void => {
      rootRef.current = node
      if (node !== null) {
        return
      }
      void flushSourceDrafts()
      cancelStructuralFrames(structuralFrameIdsRef)
    },
    [flushSourceDrafts]
  )

  // Why: leaving the notebook commits its cells, like rich markdown on blur, so another tab of
  // the file never serializes over them.
  const onRootBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      if (
        !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      ) {
        void flushSourceDrafts()
      }
    },
    [flushSourceDrafts]
  )

  const applyContent = useCallback((nextContent: string): void => {
    contentRef.current = nextContent
    onContentChangeRef.current(nextContent)
  }, [])

  const updateCellSource = useCallback(
    (index: number, source: string): void => {
      const cell = notebookRef.current?.cells[index]
      if (!cell) {
        return
      }
      const key = getIpynbCellKey(cell, index)
      const nextDrafts = { ...sourceDraftsRef.current, [key]: source }
      sourceDraftsRef.current = nextDrafts
      setSourceDrafts(nextDrafts)
      onDirtyStateHintRef.current(true)
      queueSourceDraftCommit()
    },
    [queueSourceDraftCommit]
  )

  const applyStructuralChange = useCallback(
    (getNextContent: (latestContent: string) => string): void => {
      const latestContent = flushSourceDrafts()
      onDeactivateEditor()
      requestStructuralFrame(structuralFrameIdsRef, () => {
        applyContent(getNextContent(latestContent))
      })
    },
    [applyContent, flushSourceDrafts, onDeactivateEditor]
  )

  const updateCellKind = (index: number, kind: IpynbCellKind): void => {
    const language = notebookRef.current?.language ?? 'python'
    applyStructuralChange((latestContent) =>
      updateIpynbCellKind(latestContent, index, kind, language)
    )
  }
  const insertCell = (index: number, kind: IpynbCellKind): void => {
    const language = notebookRef.current?.language ?? 'python'
    applyStructuralChange((latestContent) => insertIpynbCell(latestContent, index, kind, language))
  }
  const moveCell = (index: number, direction: -1 | 1): void => {
    applyStructuralChange((latestContent) => moveIpynbCell(latestContent, index, direction))
  }
  const deleteCell = (index: number): void => {
    applyStructuralChange((latestContent) => deleteIpynbCell(latestContent, index))
  }

  return {
    rootRef,
    setRootRef,
    onRootBlur,
    sourceDrafts,
    flushSourceDrafts,
    applyContent,
    updateCellSource,
    updateCellKind,
    insertCell,
    moveCell,
    deleteCell
  }
}
