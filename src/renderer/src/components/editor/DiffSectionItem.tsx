/* eslint-disable max-lines -- Why: this component owns diff rendering, image previews, comment popovers, and expansion state as one synchronized editor row. */
import {
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject
} from 'react'
import { LazySection } from './LazySection'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor as monacoEditor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import { joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator'
import { DiffCommentPopover } from '../diff-comments/DiffCommentPopover'
import { getDiffCommentPopoverTop } from '../diff-comments/diff-comment-popover-position'
import { applyDiffEditorLineNumberOptions } from './diff-editor-line-number-options'
import { computeLineStats } from './diff-line-stats'
import { DiffSectionHeader } from './DiffSectionHeader'
import type { DiffSection } from './diff-section-types'
import type { DiffComment } from '../../../../shared/types'
import { isDiffComment } from '@/lib/diff-comment-compat'

const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))

export function DiffSectionItem({
  section,
  index,
  isBranchMode,
  sideBySide,
  isDark,
  settings,
  sectionHeight,
  worktreeId,
  worktreeRoot,
  loadSection,
  toggleSection,
  setSectionHeights,
  setSections,
  modifiedEditorsRef,
  handleSectionSaveRef
}: {
  section: DiffSection
  index: number
  isBranchMode: boolean
  sideBySide: boolean
  isDark: boolean
  settings: { terminalFontSize?: number; terminalFontFamily?: string } | null
  sectionHeight: number | undefined
  worktreeId: string
  /** The worktree root directory — not a file path; used to resolve absolute paths for opening files. */
  worktreeRoot: string
  loadSection: (index: number) => void
  toggleSection: (index: number) => void
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  modifiedEditorsRef: MutableRefObject<Map<number, monacoEditor.IStandaloneCodeEditor>>
  handleSectionSaveRef: MutableRefObject<(index: number) => Promise<void>>
}): React.JSX.Element {
  const openFile = useAppStore((s) => s.openFile)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const scrollToDiffCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  // Why: subscribe to the raw comments array on the worktree (reference-
  // stable across unrelated store updates) and filter by filePath inside a
  // memo. Selecting a fresh `.filter(...)` result would invalidate on every
  // store change and cause needless re-renders of this section.
  const allDiffComments = useAppStore(
    (s): DiffComment[] | undefined => findWorktreeById(s.worktreesByRepo, worktreeId)?.diffComments
  )
  const diffComments = useMemo(
    () => (allDiffComments ?? []).filter((c) => c.filePath === section.path && isDiffComment(c)),
    [allDiffComments, section.path]
  )
  const language = detectLanguage(section.path)
  const isEditable = section.area === 'unstaged'
  const modelPathBase = useMemo(
    () => `diff-section:${encodeURIComponent(worktreeId)}:${encodeURIComponent(section.key)}`,
    [section.key, worktreeId]
  )
  const editorFontSize = computeEditorFontSize(
    settings?.terminalFontSize ?? 13,
    editorFontZoomLevel
  )

  const [modifiedEditor, setModifiedEditor] = useState<monacoEditor.ICodeEditor | null>(null)
  const diffEditorRef = useRef<monacoEditor.IStandaloneDiffEditor | null>(null)
  const lineNumberOptionsSubRef = useRef<{ dispose: () => void } | null>(null)
  const [popover, setPopover] = useState<{
    lineNumber: number
    startLine?: number
    top: number
  } | null>(null)

  const disposeDiffModels = useCallback(() => {
    window.setTimeout(() => {
      const originalModel = monaco.editor.getModel(monaco.Uri.parse(`${modelPathBase}:original`))
      const modifiedModel = monaco.editor.getModel(monaco.Uri.parse(`${modelPathBase}:modified`))
      if (!originalModel?.isAttachedToEditor()) {
        originalModel?.dispose()
      }
      if (!modifiedModel?.isAttachedToEditor()) {
        modifiedModel?.dispose()
      }
    }, 0)
  }, [modelPathBase])

  useEffect(() => {
    if (section.collapsed) {
      disposeDiffModels()
    }
  }, [disposeDiffModels, section.collapsed])

  useEffect(() => () => disposeDiffModels(), [disposeDiffModels])

  // Why: only forward the pending scroll id when it matches a comment in this
  // section so unrelated sections don't keep re-rendering their decorator
  // every time the sidebar requests a scroll elsewhere.
  const pendingScrollForThisSection = useMemo(() => {
    if (!scrollToDiffCommentId) {
      return null
    }
    return diffComments.some((c) => c.id === scrollToDiffCommentId) ? scrollToDiffCommentId : null
  }, [scrollToDiffCommentId, diffComments])

  useDiffCommentDecorator({
    editor: modifiedEditor,
    filePath: section.path,
    worktreeId,
    comments: diffComments,
    onAddCommentClick: ({ lineNumber, startLine, top }) =>
      setPopover({ lineNumber, startLine, top }),
    onDeleteComment: (id) => void deleteDiffComment(worktreeId, id),
    onUpdateComment: (id, body) => updateDiffComment(worktreeId, id, body),
    pendingScrollCommentId: pendingScrollForThisSection,
    onPendingScrollConsumed: () => setScrollToDiffCommentId(null)
  })

  useEffect(() => {
    if (!modifiedEditor || !popover) {
      return
    }
    const update = (): void => {
      const top = getDiffCommentPopoverTop(
        modifiedEditor,
        popover.lineNumber,
        modifiedEditor.getOption(monaco.editor.EditorOption.lineHeight)
      )
      if (top == null) {
        setPopover(null)
        return
      }
      setPopover((prev) => (prev ? { ...prev, top } : prev))
    }
    const scrollSub = modifiedEditor.onDidScrollChange(update)
    const contentSub = modifiedEditor.onDidContentSizeChange(update)
    return () => {
      scrollSub.dispose()
      contentSub.dispose()
    }
    // Why: depend on popover.lineNumber (not the whole popover object) so the
    // effect doesn't re-subscribe on every top update it dispatches. The guard
    // on `popover` above handles the popover-closed case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modifiedEditor, popover?.lineNumber])

  useEffect(() => {
    const diffEditor = diffEditorRef.current
    if (!diffEditor) {
      return
    }
    lineNumberOptionsSubRef.current?.dispose()
    lineNumberOptionsSubRef.current = applyDiffEditorLineNumberOptions(diffEditor, sideBySide)
    return () => {
      lineNumberOptionsSubRef.current?.dispose()
      lineNumberOptionsSubRef.current = null
    }
  }, [sideBySide])

  const handleSubmitComment = async (body: string): Promise<void> => {
    if (!popover) {
      return
    }
    // Why: await persistence before closing the popover. If addDiffComment
    // resolves to null, the store rolled back the optimistic insert; keeping
    // the popover open preserves the user's draft so they can retry instead
    // of silently losing their text.
    const result = await addDiffComment({
      worktreeId,
      filePath: section.path,
      source: 'diff',
      startLine: popover.startLine,
      lineNumber: popover.lineNumber,
      body,
      side: 'modified'
    })
    if (result) {
      setPopover(null)
    } else {
      console.error('Failed to add diff comment — draft preserved')
    }
  }

  const lineStats = useMemo(
    () =>
      section.loading
        ? null
        : computeLineStats(section.originalContent, section.modifiedContent, section.status),
    [section.loading, section.originalContent, section.modifiedContent, section.status]
  )

  const handleOpenInEditor = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const absolutePath = joinPath(worktreeRoot, section.path)
    openFile({
      filePath: absolutePath,
      relativePath: section.path,
      worktreeId,
      language,
      mode: 'edit'
    })
  }

  const handleMount: DiffOnMount = (editor, monaco) => {
    diffEditorRef.current = editor
    lineNumberOptionsSubRef.current?.dispose()
    lineNumberOptionsSubRef.current = applyDiffEditorLineNumberOptions(editor, sideBySide)
    const modified = editor.getModifiedEditor()

    const updateHeight = (): void => {
      const contentHeight = editor.getModifiedEditor().getContentHeight()
      setSectionHeights((prev) => {
        if (prev[index] === contentHeight) {
          return prev
        }
        return { ...prev, [index]: contentHeight }
      })
    }
    modified.onDidContentSizeChange(updateHeight)
    updateHeight()

    setModifiedEditor(modified)
    // Why: Monaco disposes inner editors when the DiffEditor container is
    // unmounted (e.g. section collapse, tab change). Clearing the state
    // prevents decorator effects and scroll subscriptions from invoking
    // methods on a disposed editor instance, and avoids `popover` pointing
    // at a line in an editor that no longer exists.
    modified.onDidDispose(() => {
      lineNumberOptionsSubRef.current?.dispose()
      lineNumberOptionsSubRef.current = null
      diffEditorRef.current = null
      setModifiedEditor(null)
      setPopover(null)
    })

    if (!isEditable) {
      return
    }

    modifiedEditorsRef.current.set(index, modified)
    modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      handleSectionSaveRef.current(index)
    )
    modified.onDidChangeModelContent(() => {
      const current = modified.getValue()
      setSections((prev) =>
        prev.map((s, i) => (i === index ? { ...s, dirty: current !== s.modifiedContent } : s))
      )
    })
  }

  return (
    <LazySection key={section.key} index={index} onVisible={loadSection}>
      <DiffSectionHeader
        path={section.path}
        dirty={section.dirty}
        collapsed={section.collapsed}
        added={lineStats?.added ?? 0}
        removed={lineStats?.removed ?? 0}
        onToggle={() => toggleSection(index)}
        onOpenInEditor={handleOpenInEditor}
      />

      {!section.collapsed && (
        <div
          className="relative"
          style={{
            height: sectionHeight
              ? sectionHeight + 19
              : Math.max(
                  60,
                  Math.max(
                    section.originalContent.split('\n').length,
                    section.modifiedContent.split('\n').length
                  ) *
                    19 +
                    19
                )
          }}
        >
          {popover && (
            // Why: key by lineNumber so the popover remounts when the anchor
            // line changes, resetting the internal draft body and textarea
            // focus per anchor line instead of leaking state across lines.
            <DiffCommentPopover
              key={popover.lineNumber}
              lineNumber={popover.lineNumber}
              startLine={popover.startLine}
              top={popover.top}
              onCancel={() => setPopover(null)}
              onSubmit={handleSubmitComment}
            />
          )}
          {section.loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
              Loading...
            </div>
          ) : section.diffResult?.kind === 'binary' ? (
            section.diffResult.isImage ? (
              <ImageDiffViewer
                originalContent={section.diffResult.originalContent}
                modifiedContent={section.diffResult.modifiedContent}
                filePath={section.path}
                mimeType={section.diffResult.mimeType}
                sideBySide={sideBySide}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">Binary file changed</div>
                  <div className="text-xs text-muted-foreground">
                    {isBranchMode
                      ? 'Text diff is unavailable for this file in branch compare.'
                      : 'Text diff is unavailable for this file.'}
                  </div>
                </div>
              </div>
            )
          ) : (
            <DiffEditor
              height="100%"
              language={language}
              original={section.originalContent}
              modified={section.modifiedContent}
              theme={isDark ? 'vs-dark' : 'vs'}
              onMount={handleMount}
              // Why: @monaco-editor/react can dispose models before widget teardown.
              // Keep them through unmount and dispose unattached models next tick.
              originalModelPath={`${modelPathBase}:original`}
              modifiedModelPath={`${modelPathBase}:modified`}
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              options={{
                readOnly: !isEditable,
                originalEditable: false,
                renderSideBySide: sideBySide,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: editorFontSize,
                fontFamily: settings?.terminalFontFamily || 'monospace',
                lineNumbers: 'on',
                automaticLayout: true,
                renderOverviewRuler: false,
                scrollbar: { vertical: 'hidden', handleMouseWheel: false },
                hideUnchangedRegions: { enabled: true },
                find: {
                  addExtraSpaceOnTop: false,
                  autoFindInSelection: 'never',
                  seedSearchStringFromSelection: 'never'
                }
              }}
            />
          )}
        </div>
      )}
    </LazySection>
  )
}
