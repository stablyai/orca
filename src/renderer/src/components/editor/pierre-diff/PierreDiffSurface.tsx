import { countLinesEmptyAsZero } from '../../../../../shared/source-control/diff/large-diff-render-limit'
import { buildPierreDiffSelectionStyle, resolvePierreDiffTheme } from './pierre-diff-theme'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import { useEditorTypography } from '@/hooks/use-editor-typography'
import { useCodeEditorThemeStore } from '@/store/appearance/code-editor-theme'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import type {
  FileDiff as PierreFileDiff,
  FileContents,
  FileDiffMetadata,
  PostRenderPhase,
  SelectedLineRange,
  VirtualizedFileDiff
} from '@pierre/diffs'
import type { Editor, EditorOptions } from '@pierre/diffs/edit'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'
import type { DecoratedDiffComment } from '../../diff-comments/decorated-diff-comment'
import {
  buildPierreDiffMetrics,
  buildPierreDiffOptions,
  buildPierreDiffStyle
} from './pierre-diff-options'
import type { PierreDiffSettings } from './pierre-diff-options'
import {
  buildPierreDiffCommentAnnotations,
  renderPierreDiffCommentAnnotation,
  type PierreDiffAnnotationData,
  type PierreDiffCommentAnnotation
} from './pierre-diff-comment-annotations'
import { usePierreDiffOverview } from './use-pierre-diff-overview'
import { usePierrePluginTokenizer } from './use-pierre-plugin-tokenizer'
import { usePierreDiffFind } from './use-pierre-diff-find'
import { PierreDiffSearchBar } from './PierreDiffSearchBar'
import { usePierreDiffShiftWheel } from './use-pierre-diff-shift-wheel'
import { usePierreDiffNativeView } from './use-pierre-diff-native-view'
import { usePierreDiffContextCopy } from './use-pierre-diff-context-copy'
import { usePierreDiffUnicodeHighlight } from './use-pierre-diff-unicode-highlight'
import { editorShortcutMatches } from '@/components/editor/commands/editor-shortcuts'
import { usePierreDiffNoteNavigation } from './use-pierre-diff-note-navigation'
import { usePierreDiffNoteSelection } from './use-pierre-diff-note-selection'
import { PierreDiffNarrowLayoutContext } from './pierre-diff-layout'
import { canCommentOnPierreRange } from './pierre-diff-comment-range'
import { withPierreDiffEditState } from './pierre-diff-edit-state'
import { shouldAutoFocusPierreDiffHost, shouldFocusPierreDiffHost } from './pierre-diff-host-focus'

export type PierreDiffInstance = PierreFileDiff<PierreDiffAnnotationData> &
  Partial<Pick<VirtualizedFileDiff, 'getLinePosition' | 'layoutVersion'>>

export type PierreDiffSurfaceProps = {
  fileDiff: FileDiffMetadata
  overviewKey?: string
  modifiedContent?: string
  sideBySide: boolean
  settings?: PierreDiffSettings | null
  isEditable: boolean
  editStateKey?: string
  /** Collapse unchanged context according to the surface preference. */
  collapseUnchanged: boolean
  /** Single-file tab only. Combined rows must not steal focus on mount. */
  autoFocusHost?: boolean
  worktreeId: string
  commentOwner?: DiffCommentOwner | null
  imageUploadAddress?: GitHubImageIntake['address']
  filePath: string
  comments: readonly DecoratedDiffComment[]
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
  onDeleteComment: (commentId: string) => void
  onUpdateComment?: (commentId: string, body: string) => Promise<boolean>
  /** Live document stream while an edit session is active. */
  onEditChange?: (file: FileContents) => void
  /** Language id for copy-with-context; omit to disable that shortcut. */
  language?: string
  /** Fires on Pierre's DOM lifecycle; used for height measurement. */
  onPostRender?: (node: HTMLElement, phase: PostRenderPhase, instance: PierreDiffInstance) => void
  /** Gutter affordance for starting a note; omit to hide it. */
  onAddComment?: (range: { lineNumber: number; startLine?: number }) => void
  commentableLineNumbers?: readonly number[]
  /** Open note draft, rendered inline on its anchor line. */
  pendingComment?: { lineNumber: number; startLine?: number } | null
  addCommentPlaceholder?: string
  addCommentLabel?: string
  onCancelComment?: () => void
  onSubmitComment?: (body: string) => Promise<boolean>
  className?: string
}

/**
 * The single diff renderer behind every Orca diff surface. Replaces the Monaco
 * `DiffEditor` that used to mount once per visible file.
 */
export function PierreDiffSurface({
  fileDiff,
  overviewKey,
  modifiedContent,
  sideBySide,
  settings,
  isEditable,
  editStateKey,
  collapseUnchanged,
  autoFocusHost = false,
  worktreeId,
  commentOwner,
  imageUploadAddress,
  filePath,
  comments,
  formatCommentPrompt,
  onDeleteComment,
  onUpdateComment,
  language,
  onEditChange,
  onPostRender,
  onAddComment,
  commentableLineNumbers,
  pendingComment,
  addCommentPlaceholder,
  addCommentLabel,
  onCancelComment,
  onSubmitComment,
  className
}: PierreDiffSurfaceProps): React.JSX.Element {
  const t = useTranslate()
  const typography = useEditorTypography('diff')
  const documentDark = useDocumentDarkTheme()
  const editorTheme = useCodeEditorThemeStore((s) => s.monaco)
  const diffTheme = useMemo(() => resolvePierreDiffTheme(editorTheme), [editorTheme])
  const editorBase = useCodeEditorThemeStore((s) => s.override?.base)
  const themeType = editorBase ?? (documentDark ? 'dark' : 'light')
  const narrowLayout = useContext(PierreDiffNarrowLayoutContext)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
  const activeGroupId = useAppStore((s) =>
    worktreeId ? (s.activeGroupIdByWorktree[worktreeId] ?? worktreeId) : worktreeId
  )
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor<'file-diff', PierreDiffAnnotationData, undefined> | null>(null)
  // Why layout, not render: the auto-focus effect re-runs when isEditable flips, so this must
  // track the current group. A render-phase write is impure -- React can discard it.
  const autoFocusContextRef = useRef({ worktreeId, activeGroupId })
  useLayoutEffect(() => {
    autoFocusContextRef.current = { worktreeId, activeGroupId }
  }, [worktreeId, activeGroupId])
  // Why: Monaco focused the single-file DiffEditor on mount so Cmd+F/F7 worked
  // without a click. Combined DiffSectionItem did not — do not steal there.
  // Skip when the user already moved to a terminal/input or another tab group;
  // a late parse completing must not yank that caret. Group identity is read
  // from a ref so switching groups does not retrigger focus.
  useLayoutEffect(() => {
    // Why read-only only: the regression this fixes is Cmd+F/F7 being dead on a diff opened from
    // the sidebar, which needs the light-DOM host focused. An editable surface must NOT get that
    // -- Pierre's contenteditable lives in a shadow root, and focusing the host blurs it, so every
    // keystroke is dropped. Editable diffs already worked before this effect existed.
    if (!autoFocusHost || isEditable) {
      return
    }
    const host = containerRef.current
    if (!host) {
      return
    }
    const { worktreeId: focusWorktreeId, activeGroupId: focusGroupId } = autoFocusContextRef.current
    const group = host.closest<HTMLElement>('[data-tab-group-body-id]')
    if (focusWorktreeId && group && group.dataset.tabGroupBodyId !== focusGroupId) {
      return
    }
    if (!shouldAutoFocusPierreDiffHost(host, document.activeElement)) {
      return
    }
    host.focus({ preventScroll: true })
  }, [autoFocusHost, isEditable])
  const { onPostRender: overviewPostRender, onEditChange: overviewEditChange } =
    usePierreDiffOverview(
      overviewKey ?? filePath,
      fileDiff,
      editorRef,
      JSON.stringify([sideBySide && !narrowLayout, collapseUnchanged, typography])
    )
  const onEditChangeRef = useRef(onEditChange)
  const {
    searchBar,
    handleContainerKeyDown,
    onPointerDown,
    onPostRender: searchPostRender,
    onEditChange: searchEditChange
  } = usePierreDiffFind({ isEditable, containerRef, editorRef, fileDiff })
  useLayoutEffect(() => {
    onEditChangeRef.current = (file) => {
      onEditChange?.(file)
      searchEditChange()
      overviewEditChange()
    }
  }, [onEditChange, searchEditChange, overviewEditChange])
  const shiftWheelPostRender = usePierreDiffShiftWheel()
  const nativeViewPostRender = usePierreDiffNativeView(
    editStateKey,
    fileDiff,
    isEditable,
    containerRef,
    activeGroupId,
    editorRef
  )
  const commentableLines = useMemo(
    () => (commentableLineNumbers ? new Set(commentableLineNumbers) : null),
    [commentableLineNumbers]
  )
  const noteSelection = usePierreDiffNoteSelection({
    containerRef,
    editorRef,
    onAddComment,
    pendingComment,
    commentableLines
  })
  const navigateToNote = usePierreDiffNoteNavigation({ worktreeId, filePath, comments })
  const unicodePostRender = usePierreDiffUnicodeHighlight(language)
  const postRenderChain = useMemo(
    () => [
      onPostRender,
      navigateToNote,
      searchPostRender,
      shiftWheelPostRender,
      nativeViewPostRender,
      noteSelection.onPostRender,
      unicodePostRender,
      overviewPostRender
    ],
    [
      onPostRender,
      navigateToNote,
      searchPostRender,
      shiftWheelPostRender,
      nativeViewPostRender,
      noteSelection.onPostRender,
      unicodePostRender,
      overviewPostRender
    ]
  )
  const postRenderRef = useRef(postRenderChain)
  // Keep Pierre's render callback stable; committed callbacks may lag a child layout effect.
  useLayoutEffect(() => {
    postRenderRef.current = postRenderChain
  }, [postRenderChain])
  const handlePostRender = useCallback(
    (node: HTMLElement, instance: PierreDiffInstance, phase: PostRenderPhase) => {
      for (const postRender of postRenderRef.current) {
        postRender?.(node, phase, instance)
      }
    },
    []
  )

  usePierreDiffContextCopy(containerRef, filePath, language)

  const options = useMemo(
    () => ({
      ...buildPierreDiffOptions<PierreDiffAnnotationData>({
        settings: { ...settings, theme: themeType },
        sideBySide: sideBySide && !narrowLayout,
        collapseUnchanged
      }),
      theme: diffTheme,
      enableGutterUtility: Boolean(onAddComment),
      canUseGutterUtility: (range: SelectedLineRange) =>
        canCommentOnPierreRange(range, commentableLines),
      gutterUtilityLabel:
        addCommentLabel ??
        t('auto.components.editor.MarkdownPreview.d737791433', 'Add note for the AI'),
      onGutterUtilityClick: onAddComment ? noteSelection.addComment : undefined,
      onLineSelectionEnd: onAddComment ? noteSelection.onLineSelectionEnd : undefined,
      onPostRender: handlePostRender
    }),
    [
      t,
      diffTheme,
      themeType,
      settings,
      sideBySide,
      narrowLayout,
      collapseUnchanged,
      onAddComment,
      handlePostRender,
      commentableLines,
      addCommentLabel,
      noteSelection.addComment,
      noteSelection.onLineSelectionEnd
    ]
  )
  const style = useMemo(() => {
    return {
      ...buildPierreDiffStyle(settings, editorFontZoomLevel, typography),
      ...buildPierreDiffSelectionStyle(editorTheme, themeType)
    }
  }, [settings, editorFontZoomLevel, typography, editorTheme, themeType])
  const metrics = useMemo(
    () => buildPierreDiffMetrics(settings, editorFontZoomLevel, typography),
    [settings, editorFontZoomLevel, typography]
  )
  const lineAnnotations = useMemo(
    () =>
      buildPierreDiffCommentAnnotations(
        comments,
        filePath,
        pendingComment,
        modifiedContent === undefined
          ? fileDiff.additionLines.length
          : countLinesEmptyAsZero(modifiedContent)
      ),
    [comments, filePath, pendingComment, fileDiff.additionLines.length, modifiedContent]
  )
  const createTokenizer = usePierrePluginTokenizer(filePath, language ?? 'plaintext')
  const editorOptions = useMemo<EditorOptions<'file-diff', PierreDiffAnnotationData, undefined>>(
    () =>
      withPierreDiffEditState(
        {
          createTokenizer,
          onAttach: (editor) => {
            editorRef.current = editor
            const host = containerRef.current
            // Host focus lands in layout before Pierre queues onAttach. If we still
            // own it, move to the editor so Changes-mode typing works without a click.
            if (autoFocusHost && host && document.activeElement === host) {
              editor.focus({ preventScroll: true })
            }
          },
          onComplete: () => {
            editorRef.current = null
          },
          onChange: (event) => {
            if (isEditable) {
              onEditChangeRef.current?.(event.file)
            }
          }
        },
        isEditable ? editStateKey : undefined,
        fileDiff
      ),
    [autoFocusHost, isEditable, editStateKey, fileDiff, createTokenizer]
  )
  const renderAnnotation = useCallback(
    (annotation: PierreDiffCommentAnnotation) =>
      renderPierreDiffCommentAnnotation(annotation, {
        worktreeId,
        commentOwner,
        imageUploadAddress,
        filePath,
        activeGroupId,
        formatCommentPrompt,
        onDeleteComment,
        onUpdateComment,
        clearDeliveredDiffComments,
        draftPlaceholder: addCommentPlaceholder,
        draftSubmitLabel: addCommentLabel,
        onCancelDraft: onCancelComment,
        onSubmitDraft: onSubmitComment,
        retainKey: editStateKey && `note:${editStateKey}`
      }),
    [
      worktreeId,
      commentOwner,
      imageUploadAddress,
      filePath,
      activeGroupId,
      formatCommentPrompt,
      onDeleteComment,
      onUpdateComment,
      clearDeliveredDiffComments,
      addCommentPlaceholder,
      addCommentLabel,
      onCancelComment,
      onSubmitComment,
      editStateKey
    ]
  )

  return (
    // Why: ⌘F must be caught before Pierre mounts an editor, so the listener lives on the host.
    // Why tabIndex: Monaco's editor could hold focus, so the shortcut reached it. A plain div
    // cannot, and a read-only diff has no contenteditable, so focus would sit on <body> and the
    // handler would never fire. Focus on pointer-down makes the diff the key target like before.
    <div
      ref={containerRef}
      data-editor-keyboard-scope
      tabIndex={-1}
      className={['editor-typography-surface', className].filter(Boolean).join(' ')}
      onMouseDown={(event) => {
        if (
          shouldFocusPierreDiffHost(event.currentTarget, document.activeElement, event.nativeEvent)
        ) {
          event.currentTarget.focus({ preventScroll: true })
        }
      }}
      onPointerDownCapture={onPointerDown}
      onPointerUp={() => {
        // Pierre must consume the native caret before a keystroke can arrive.
        if (isEditable) {
          document.dispatchEvent(new Event('selectionchange'))
        }
      }}
      onKeyDownCapture={(event) => {
        if (isEditable && editorShortcutMatches('editor.save', event)) {
          // Saving separates later typing from the saved undo group.
          const lastEdit = editorRef.current?.getEditState()?.document.history.undoStack.at(-1)
          if (lastEdit) {
            lastEdit.undoBoundary = true
          }
        }
        handleContainerKeyDown(event)
      }}
    >
      {searchBar && <PierreDiffSearchBar {...searchBar} />}
      {/* Why: @pierre/diffs throws from its own ref teardown on some remounts
          ("A FileDiff instance should exist when unmounting"). Contain it to the
          one file instead of letting an experimental dependency take down the
          whole terminal workbench. */}
      <RecoverableRenderErrorBoundary
        boundaryId="editor.pierre-diff-surface"
        surface="page"
        compact
        // Why cacheKey and not just the name: editStateKey is tab/section identity and name is the
        // path, so neither moves when only the contents change. A caught render throw would stay
        // latched through a save, an agent rewrite or a refetch, because the same surface stays
        // mounted while `sameFile` holds. cacheKey is derived from the content.
        resetKey={`${editStateKey ?? fileDiff.name}:${fileDiff.cacheKey ?? fileDiff.name}`}
        title={t('editor.diff.renderFailed', 'This diff could not be rendered')}
        description={t('editor.diff.renderRetry', 'Reopen the file or reload to try again.')}
      >
        <FileDiff<PierreDiffAnnotationData>
          fileDiff={fileDiff}
          options={options}
          style={style}
          metrics={metrics}
          edit={isEditable}
          editorOptions={editorOptions}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
        />
      </RecoverableRenderErrorBoundary>
    </div>
  )
}
