import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'

import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import {
  shortcutAddStoryComment,
  shortcutStoryComments,
  type RuntimeShortcutSettings
} from '@/runtime/runtime-shortcut-client'
import type { ShortcutComment, ShortcutStory } from '../../../shared/shortcut-types'
import { translate } from '@/i18n/i18n'

export type ShortcutStoryCommentsState = {
  comments: ShortcutComment[]
  commentsLoading: boolean
  commentsError: string | null
  commentDraft: string
  setCommentDraft: (value: string) => void
  commentSubmitting: boolean
  canSubmitComment: boolean
  loadComments: (targetStory: ShortcutStory, requestId: number) => Promise<void>
  resetComments: () => void
  submitComment: (displayed: ShortcutStory | null) => Promise<void>
}

export function useShortcutStoryComments(
  providerSettings: RuntimeShortcutSettings,
  requestIdRef: React.MutableRefObject<number>
): ShortcutStoryCommentsState {
  const [comments, setComments] = useState<ShortcutComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  // Why: a just-posted comment can lag out of the provider read; keep it visible
  // until a later fetch returns it.
  const optimisticCommentsRef = useRef<ShortcutComment[]>([])

  const loadComments = useCallback(
    async (targetStory: ShortcutStory, requestId: number): Promise<void> => {
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = await shortcutStoryComments(
          providerSettings,
          targetStory.id,
          targetStory.workspaceId
        )
        if (requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.id))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
        }
        setComments(fetched)
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [providerSettings, requestIdRef]
  )

  const resetComments = useCallback((): void => {
    optimisticCommentsRef.current = []
    setComments([])
    setCommentsError(null)
    setCommentDraft('')
  }, [])

  const submitComment = useCallback(
    async (displayed: ShortcutStory | null): Promise<void> => {
      if (!displayed || commentSubmitting) {
        return
      }
      const bodyState = getCommentBodySubmitState(commentDraft)
      if (bodyState.status === 'empty') {
        return
      }
      if (bodyState.status === 'too-large-leading-whitespace') {
        toast.error(
          translate(
            'auto.components.ShortcutStoryWorkspace.commentTooLarge',
            'Comment is too large to submit safely.'
          )
        )
        return
      }
      setCommentSubmitting(true)
      try {
        const result = await shortcutAddStoryComment(
          providerSettings,
          displayed.id,
          bodyState.body,
          displayed.workspaceId
        )
        if (!result.ok) {
          throw new Error(result.error)
        }
        const comment: ShortcutComment = {
          id: result.id || createBrowserUuid(),
          body: bodyState.body,
          createdAt: new Date().toISOString(),
          author: { id: 'local', name: 'You' }
        }
        optimisticCommentsRef.current.push(comment)
        setComments((prev) => [...prev, comment])
        setCommentDraft('')
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.ShortcutStoryWorkspace.commentFailed',
                'Failed to add comment.'
              )
        )
      } finally {
        setCommentSubmitting(false)
      }
    },
    [commentDraft, commentSubmitting, providerSettings]
  )

  return {
    comments,
    commentsLoading,
    commentsError,
    commentDraft,
    setCommentDraft,
    commentSubmitting,
    canSubmitComment: hasBoundedCommentBodyText(commentDraft),
    loadComments,
    resetComments,
    submitComment
  }
}
