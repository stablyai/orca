import { useCallback } from 'react'
import { Check, Copy, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  formatMarkdownReviewCardQuote,
  getMarkdownReviewCardQuote,
  type MarkdownReviewNote
} from '@/lib/markdown-review-notes'
import { DiffCommentCard } from '../diff-comments/DiffCommentCard'
import {
  MarkdownPreviewAnnotationComposer,
  MarkdownPreviewSingleNoteSendMenu
} from './MarkdownPreviewAnnotationComposer'
import {
  getMarkdownPreviewAnnotationQuote,
  getMarkdownPreviewBlockRange
} from './markdown-preview-block-model'
import type {
  MarkdownPreviewBlockRange,
  MarkdownPreviewPositionNode
} from './markdown-preview-types'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { MarkdownPreviewReviewActions } from './use-markdown-preview-review-actions'

export function useMarkdownPreviewAnnotationRenderers({
  foundation,
  reviewActions,
  filePath,
  content,
  markdownAnnotationsEnabled
}: {
  foundation: MarkdownPreviewFoundation
  reviewActions: MarkdownPreviewReviewActions
  filePath: string
  content: string
  markdownAnnotationsEnabled: boolean
}) {
  const {
    sourceWorktree,
    sourceRelativePath,
    activeAnnotationBlockKey,
    setActiveAnnotationBlockKey,
    activeReviewCommentId,
    attentionReviewCommentId,
    addDiffComment,
    clearDeliveredDiffComments,
    copiedReviewNoteId,
    deleteDiffComment,
    renderedContent,
    updateDiffComment
  } = foundation
  const {
    getMarkdownCommentsForRange,
    handleAnnotatedMarkdownBlockClick,
    handleCopyMarkdownReviewNote
  } = reviewActions

  const renderAnnotationControls = useCallback(
    (
      range: MarkdownPreviewBlockRange,
      blockKey: string,
      annotationQuote?: string
    ): React.ReactNode => {
      if (!sourceWorktree || sourceRelativePath === null) {
        return null
      }
      if (!markdownAnnotationsEnabled) {
        return null
      }
      const commentsForBlock = getMarkdownCommentsForRange(range)

      const handleSubmit = async (body: string): Promise<boolean> => {
        const result = await addDiffComment({
          worktreeId: sourceWorktree.id,
          filePath: sourceRelativePath,
          source: 'markdown',
          startLine: range.startLine === range.endLine ? undefined : range.startLine,
          lineNumber: range.endLine,
          ...(annotationQuote ? { selectedText: annotationQuote } : {}),
          body,
          side: 'modified'
        })
        if (result) {
          setActiveAnnotationBlockKey(null)
          return true
        }
        return false
      }

      return (
        <div className="markdown-annotation-controls">
          <button
            type="button"
            className="markdown-annotation-add"
            aria-label={translate('auto.components.editor.MarkdownPreview.13f94d760c', 'Add note')}
            title={translate('auto.components.editor.MarkdownPreview.13f94d760c', 'Add note')}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setActiveAnnotationBlockKey((current) => (current === blockKey ? null : blockKey))
            }}
          >
            <Plus className="size-3" />
          </button>
          {activeAnnotationBlockKey === blockKey ? (
            <MarkdownPreviewAnnotationComposer
              lineNumber={range.endLine}
              startLine={range.startLine === range.endLine ? undefined : range.startLine}
              onCancel={() => setActiveAnnotationBlockKey(null)}
              onSubmit={handleSubmit}
            />
          ) : null}
          <div className="markdown-annotation-note-stack">
            {commentsForBlock.map((comment) => (
              <div
                key={comment.id}
                data-markdown-review-note-id={comment.id}
                className={`markdown-annotation-card ${
                  activeReviewCommentId === comment.id ? 'is-active' : ''
                } ${attentionReviewCommentId === comment.id ? 'is-attention' : ''}`.trim()}
              >
                <DiffCommentCard
                  lineNumber={comment.lineNumber}
                  startLine={comment.startLine}
                  label={null}
                  quote={
                    formatMarkdownReviewCardQuote(comment.selectedText) ??
                    annotationQuote ??
                    getMarkdownReviewCardQuote(content, comment)
                  }
                  body={comment.body}
                  sentAt={comment.sentAt}
                  onDelete={() => void deleteDiffComment(sourceWorktree.id, comment.id)}
                  onSubmitEdit={(body) => updateDiffComment(sourceWorktree.id, comment.id, body)}
                  headerActions={
                    <>
                      <button
                        type="button"
                        className="orca-diff-comment-pill-btn"
                        title={
                          copiedReviewNoteId === comment.id
                            ? translate(
                                'auto.components.editor.MarkdownPreview.94b520a96a',
                                'Copied note'
                              )
                            : translate(
                                'auto.components.editor.MarkdownPreview.f961e94057',
                                'Copy note for agent'
                              )
                        }
                        aria-label={
                          copiedReviewNoteId === comment.id
                            ? translate(
                                'auto.components.editor.MarkdownPreview.94b520a96a',
                                'Copied note'
                              )
                            : translate(
                                'auto.components.editor.MarkdownPreview.f961e94057',
                                'Copy note for agent'
                              )
                        }
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void handleCopyMarkdownReviewNote(comment as MarkdownReviewNote)
                        }}
                      >
                        {copiedReviewNoteId === comment.id ? (
                          <Check className="size-3" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                      <MarkdownPreviewSingleNoteSendMenu
                        worktreeId={sourceWorktree.id}
                        filePath={filePath}
                        content={renderedContent}
                        note={comment as MarkdownReviewNote}
                        modeSlot="preview-inline"
                        onDelivered={(notes) =>
                          void clearDeliveredDiffComments(sourceWorktree.id, notes)
                        }
                      />
                    </>
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )
    },
    [
      activeAnnotationBlockKey,
      activeReviewCommentId,
      attentionReviewCommentId,
      addDiffComment,
      clearDeliveredDiffComments,
      copiedReviewNoteId,
      deleteDiffComment,
      filePath,
      getMarkdownCommentsForRange,
      handleCopyMarkdownReviewNote,
      markdownAnnotationsEnabled,
      content,
      renderedContent,
      setActiveAnnotationBlockKey,
      sourceRelativePath,
      sourceWorktree,
      updateDiffComment
    ]
  )

  const wrapAnnotatedBlock = useCallback(
    (
      tagName: string,
      node: MarkdownPreviewPositionNode | undefined,
      rendered: React.ReactNode
    ): React.ReactNode => {
      const range = getMarkdownPreviewBlockRange(node)
      if (!range) {
        return rendered
      }
      const blockKey = `${tagName}:${range.startLine}-${range.endLine}`
      const controls = renderAnnotationControls(
        range,
        blockKey,
        getMarkdownPreviewAnnotationQuote(rendered)
      )
      if (!controls) {
        return rendered
      }
      const hasReviewNotes = getMarkdownCommentsForRange(range).length > 0
      return (
        <div
          className={`markdown-annotation-block ${hasReviewNotes ? 'has-review-notes' : ''}`.trim()}
          data-source-line={range.startLine}
          data-source-end-line={range.endLine}
          data-annotation-block-key={blockKey}
          onClick={(event) => handleAnnotatedMarkdownBlockClick(range, event)}
        >
          {rendered}
          {controls}
        </div>
      )
    },
    [getMarkdownCommentsForRange, handleAnnotatedMarkdownBlockClick, renderAnnotationControls]
  )

  return { renderAnnotationControls, wrapAnnotatedBlock }
}

export type MarkdownPreviewAnnotationRenderers = ReturnType<
  typeof useMarkdownPreviewAnnotationRenderers
>
