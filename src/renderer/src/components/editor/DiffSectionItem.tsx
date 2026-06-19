import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from 'react'
import type { DiffOnMount } from '@monaco-editor/react'
import type { editor as monacoEditor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { computeDiffEditorFontSize } from '@/lib/editor-font-zoom'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  useDiffCommentDecorator,
  type DecoratedDiffComment
} from '../diff-comments/useDiffCommentDecorator'
import {
  getDiffCommentPopoverLeft,
  getDiffCommentPopoverTop
} from '../diff-comments/diff-comment-popover-position'
import { applyDiffEditorLineNumberOptions } from './diff-editor-line-number-options'
import { DiffSectionHeader } from './DiffSectionHeader'
import type { DiffSection } from './diff-section-types'
import type { DiffComment } from '../../../../shared/types'
import { isDiffComment } from '@/lib/diff-comment-compat'
import { installEditorSaveShortcut } from './editor-shortcuts'
import { DiffSectionBody } from './DiffSectionBody'
import { useDiffSectionLayoutMetrics } from './useDiffSectionLayoutMetrics'
import { disposeUnattachedMonacoModelPaths } from './diff-monaco-model-disposal'
import { getLiveDiffSectionRenderLimit } from './diff-section-live-render-limit'
import { useDiffSectionFallbackCleanup } from './useDiffSectionFallbackCleanup'
import { submitDiffSectionComment } from './diff-section-comment-submit'

export function DiffSectionItem({
  section,
  index,
  isBranchMode,
  sideBySide,
  isDark,
  settings,
  sectionHeight,
  worktreeId,
  loadSection,
  retrySection,
  toggleSection,
  openSection,
  openSectionTitle,
  renderHeaderTrailingContent,
  onAddLineComment,
  addLineCommentLabel,
  addLineCommentPlaceholder,
  inlineComments,
  getCommentableLineNumbers,
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
  worktreeId?: string
  loadSection: (index: number) => void
  retrySection: (index: number) => void
  toggleSection: (index: number) => void
  openSection: (index: number) => void
  openSectionTitle: string
  renderHeaderTrailingContent?: (section: DiffSection, index: number) => ReactNode
  onAddLineComment?: (
    section: DiffSection,
    args: {
      lineNumber: number
      startLine?: number
      body: string
    }
  ) => Promise<boolean>
  addLineCommentLabel?: string
  addLineCommentPlaceholder?: string
  inlineComments?: readonly DecoratedDiffComment[]
  getCommentableLineNumbers?: (section: DiffSection) => readonly number[] | undefined
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  modifiedEditorsRef: MutableRefObject<Map<number, monacoEditor.IStandaloneCodeEditor>>
  handleSectionSaveRef: MutableRefObject<(index: number) => Promise<void>>
}): React.JSX.Element {
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
  const allDiffComments = useAppStore((s): DiffComment[] | undefined =>
    worktreeId ? findWorktreeById(s.worktreesByRepo, worktreeId)?.diffComments : undefined
  )
  const diffComments = useMemo(
    () => (allDiffComments ?? []).filter((c) => c.filePath === section.path && isDiffComment(c)),
    [allDiffComments, section.path]
  )
  const language = detectLanguage(section.path)
  const isEditable = section.area === 'unstaged'
  const modelPathBase = useMemo(
    () =>
      `diff-section:${encodeURIComponent(worktreeId ?? 'review')}:${encodeURIComponent(section.key)}:${section.contentGeneration ?? 0}`,
    [section.contentGeneration, section.key, worktreeId]
  )
  const diffEditorFontSize = computeDiffEditorFontSize(
    settings?.terminalFontSize ?? 13,
    editorFontZoomLevel
  )

  const [modifiedEditor, setModifiedEditor] = useState<monacoEditor.ICodeEditor | null>(null)
  const diffEditorRef = useRef<monacoEditor.IStandaloneDiffEditor | null>(null)
  const sectionBodyRef = useRef<HTMLDivElement | null>(null)
  const lineNumberOptionsSubRef = useRef<{ dispose: () => void } | null>(null)
  const [popover, setPopover] = useState<{
    lineNumber: number
    startLine?: number
    top: number
    left?: number
    lineHeight: number
  } | null>(null)
  const hasLineCommentAction = Boolean(worktreeId || onAddLineComment)

  const disposeDiffModels = useCallback(() => {
    window.setTimeout(() => {
      disposeUnattachedMonacoModelPaths(monaco, [
        `${modelPathBase}:original`,
        `${modelPathBase}:modified`
      ])
    }, 0)
  }, [modelPathBase])
  const disposeDiffModelsRef = useRef(disposeDiffModels)
  disposeDiffModelsRef.current = disposeDiffModels

  const setSectionRootNode = useCallback((node: HTMLDivElement | null): void => {
    if (node) {
      return
    }
    // Why: virtualized diff rows remount as their keyed section/collapse state
    // changes; the row root is the owner of the detached Monaco models.
    disposeDiffModelsRef.current()
  }, [])

  useEffect(() => {
    if (section.collapsed) {
      disposeDiffModels()
    }
  }, [disposeDiffModels, section.collapsed])

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
    editor: hasLineCommentAction ? modifiedEditor : null,
    filePath: section.path,
    worktreeId: worktreeId ?? '',
    comments: inlineComments ?? (worktreeId ? diffComments : []),
    commentableLineNumbers: getCommentableLineNumbers?.(section),
    addButtonLabel: addLineCommentLabel,
    onAddCommentClick: ({ lineNumber, startLine, top }) =>
      setPopover({
        lineNumber,
        startLine,
        top,
        left: modifiedEditor
          ? (getDiffCommentPopoverLeft(modifiedEditor, sectionBodyRef.current) ?? undefined)
          : undefined,
        lineHeight: modifiedEditor?.getOption(monaco.editor.EditorOption.lineHeight) ?? 0
      }),
    onDeleteComment: (id) => {
      if (worktreeId) {
        void deleteDiffComment(worktreeId, id)
      }
    },
    onUpdateComment: worktreeId ? (id, body) => updateDiffComment(worktreeId, id, body) : undefined,
    pendingScrollCommentId: pendingScrollForThisSection,
    onPendingScrollConsumed: () => setScrollToDiffCommentId(null)
  })

  useEffect(() => {
    if (!modifiedEditor || !popover) {
      return
    }
    const update = (): void => {
      const lineHeight = modifiedEditor.getOption(monaco.editor.EditorOption.lineHeight)
      const top = getDiffCommentPopoverTop(modifiedEditor, popover.lineNumber, lineHeight)
      if (top == null) {
        setPopover(null)
        return
      }
      const left = getDiffCommentPopoverLeft(modifiedEditor, sectionBodyRef.current)
      setPopover((prev) =>
        prev ? { ...prev, top, left: left == null ? prev.left : left, lineHeight } : prev
      )
    }
    const scrollSub = modifiedEditor.onDidScrollChange(update)
    const contentSub = modifiedEditor.onDidContentSizeChange(update)
    const layoutSub = modifiedEditor.onDidLayoutChange(update)
    return () => {
      scrollSub.dispose()
      contentSub.dispose()
      layoutSub.dispose()
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
    const submitted = await submitDiffSectionComment({
      addDiffComment,
      body,
      onAddLineComment,
      popover,
      section,
      worktreeId
    })
    if (submitted) {
      setPopover(null)
    }
  }

  const { lineStats, sectionBodyHeight, useIntrinsicImageHeight, isLargeDiffLimited } =
    useDiffSectionLayoutMetrics({
      section,
      sectionHeight
    })

  useDiffSectionFallbackCleanup({
    disposeDiffModels,
    index,
    isLargeDiffLimited,
    setSectionHeights
  })

  const handleMount: DiffOnMount = (editor, _monaco) => {
    diffEditorRef.current = editor
    lineNumberOptionsSubRef.current?.dispose()
    lineNumberOptionsSubRef.current = applyDiffEditorLineNumberOptions(editor, sideBySide)
    const modified = editor.getModifiedEditor()

    // Why: measuring before Monaco computes hidden unchanged regions records
    // full-file height, making virtualized combined diffs jump as rows remount.
    let diffLayoutReady = false
    let pendingHeightFrame: number | null = null
    const updateHeight = (): void => {
      const contentHeight = editor.getModifiedEditor().getContentHeight()
      setSectionHeights((prev) => {
        if (prev[index] === contentHeight) {
          return prev
        }
        return { ...prev, [index]: contentHeight }
      })
    }
    const requestHeightUpdate = (): void => {
      if (pendingHeightFrame !== null) {
        return
      }
      pendingHeightFrame = window.requestAnimationFrame(() => {
        pendingHeightFrame = null
        updateHeight()
      })
    }
    const markDiffLayoutReady = (): void => {
      diffLayoutReady = true
      requestHeightUpdate()
    }
    const contentSizeSub = modified.onDidContentSizeChange(() => {
      if (diffLayoutReady) {
        requestHeightUpdate()
      }
    })
    const diffUpdateSub = editor.onDidUpdateDiff(markDiffLayoutReady)
    if (editor.getLineChanges() !== null) {
      markDiffLayoutReady()
    }

    setModifiedEditor(modified)
    // Why: Monaco disposes inner editors when the DiffEditor container is
    // unmounted (e.g. section collapse, tab change). Clearing the state
    // prevents decorator effects and scroll subscriptions from invoking
    // methods on a disposed editor instance, and avoids `popover` pointing
    // at a line in an editor that no longer exists.
    modified.onDidDispose(() => {
      contentSizeSub.dispose()
      diffUpdateSub.dispose()
      if (pendingHeightFrame !== null) {
        window.cancelAnimationFrame(pendingHeightFrame)
        pendingHeightFrame = null
      }
      lineNumberOptionsSubRef.current?.dispose()
      lineNumberOptionsSubRef.current = null
      diffEditorRef.current = null
      if (modifiedEditorsRef.current.get(index) === modified) {
        modifiedEditorsRef.current.delete(index)
      }
      setModifiedEditor(null)
      setPopover(null)
    })

    if (!isEditable) {
      return
    }

    modifiedEditorsRef.current.set(index, modified)
    const cleanupSaveShortcut = installEditorSaveShortcut(modified.getContainerDomNode(), () =>
      handleSectionSaveRef.current(index)
    )
    const modelContentSub = modified.onDidChangeModelContent(() => {
      const current = modified.getValue()
      setSections((prev) => {
        let changed = false
        const next = prev.map((s, i) => {
          if (i !== index) {
            return s
          }

          const savedModifiedContent =
            s.diffResult?.kind === 'text' ? s.diffResult.modifiedContent : s.modifiedContent
          const dirty = current !== savedModifiedContent
          if (s.modifiedContent === current && s.dirty === dirty) {
            return s
          }

          changed = true
          // Why: virtualized rows unmount when scrolled away, so the draft must
          // live in section state instead of only in Monaco's mounted model.
          return {
            ...s,
            modifiedContent: current,
            dirty,
            largeDiffRenderLimit: getLiveDiffSectionRenderLimit({
              section: s,
              modifiedEditor: modified,
              modifiedContent: current
            })
          }
        })
        return changed ? next : prev
      })
    })
    modified.onDidDispose(() => {
      // Why: editable diff sections own both the save shortcut and model-change
      // subscription for this Monaco editor instance.
      cleanupSaveShortcut()
      modelContentSub.dispose()
    })
  }

  useEffect(() => {
    loadSection(index)
  }, [index, loadSection])

  return (
    <div ref={setSectionRootNode} className="border-b border-border">
      <DiffSectionHeader
        path={section.path}
        dirty={section.dirty}
        collapsed={section.collapsed}
        added={lineStats?.added ?? section.added ?? 0}
        removed={lineStats?.removed ?? section.removed ?? 0}
        onToggle={() => toggleSection(index)}
        onOpenSection={(event) => {
          event.stopPropagation()
          openSection(index)
        }}
        openSectionTitle={openSectionTitle}
        trailingContent={renderHeaderTrailingContent?.(section, index)}
      />

      {!section.collapsed && (
        <DiffSectionBody
          section={section}
          index={index}
          sectionBodyRef={sectionBodyRef}
          sectionBodyHeight={sectionBodyHeight}
          useIntrinsicImageHeight={useIntrinsicImageHeight}
          popover={popover}
          addLineCommentPlaceholder={addLineCommentPlaceholder}
          addLineCommentLabel={addLineCommentLabel}
          isBranchMode={isBranchMode}
          sideBySide={sideBySide}
          isDark={isDark}
          language={language}
          modelPathBase={modelPathBase}
          isEditable={isEditable}
          diffEditorFontSize={diffEditorFontSize}
          terminalFontFamily={settings?.terminalFontFamily}
          onCancelComment={() => setPopover(null)}
          onSubmitComment={handleSubmitComment}
          onRetrySection={retrySection}
          onSaveLimitedDiff={() => {
            void handleSectionSaveRef.current(index)
          }}
          onMount={handleMount}
        />
      )}
    </div>
  )
}
