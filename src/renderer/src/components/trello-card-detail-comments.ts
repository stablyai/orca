import { useCallback, useRef, useState } from 'react'
import type { TrelloComment } from '../../../shared/trello-types'
import { useAppStore } from '@/store'

type UseTrelloCardDetailCommentsArgs = {
  cardId: string
  setError: (value: string | null) => void
}

type CurrentTrelloCardCommentState = {
  comments: TrelloComment[]
  commentsLoading: boolean
  commentsError: string | null
  commentText: string
  commentSubmitting: boolean
  setCommentText: (value: string) => void
  loadComments: (options?: { force?: boolean }) => Promise<void>
  addComment: () => Promise<void>
}

type StoredTrelloCardCommentState = {
  cardId: string
  comments: TrelloComment[]
  commentsLoading: boolean
  commentsError: string | null
  commentText: string
  commentSubmitting: boolean
}

function emptyCommentState(cardId: string): StoredTrelloCardCommentState {
  return {
    cardId,
    comments: [],
    commentsLoading: false,
    commentsError: null,
    commentText: '',
    commentSubmitting: false
  }
}

function stateForCard(
  state: StoredTrelloCardCommentState,
  cardId: string
): StoredTrelloCardCommentState {
  if (state.cardId === cardId) {
    return state
  }
  return emptyCommentState(cardId)
}

export function useTrelloCardDetailComments({
  cardId,
  setError
}: UseTrelloCardDetailCommentsArgs): CurrentTrelloCardCommentState {
  const fetchTrelloComments = useAppStore((state) => state.fetchTrelloComments)
  const addTrelloCardComment = useAppStore((state) => state.addTrelloCardComment)
  const [storedState, setStoredState] = useState(() => emptyCommentState(cardId))
  const requestIdRef = useRef(0)
  const currentState = stateForCard(storedState, cardId)

  const setCommentText = useCallback(
    (value: string): void => {
      setStoredState((state) => ({
        ...stateForCard(state, cardId),
        commentText: value
      }))
    },
    [cardId]
  )

  const loadComments = useCallback(
    async (options?: { force?: boolean }): Promise<void> => {
      const requestId = ++requestIdRef.current
      setStoredState((state) => ({
        ...stateForCard(state, cardId),
        commentsLoading: true,
        commentsError: null
      }))
      try {
        const result = await fetchTrelloComments(cardId, options)
        if (requestId !== requestIdRef.current) {
          return
        }
        setStoredState((state) => ({
          ...stateForCard(state, cardId),
          comments: result
        }))
      } catch (err) {
        if (requestId !== requestIdRef.current) {
          return
        }
        setStoredState((state) => ({
          ...stateForCard(state, cardId),
          commentsError: err instanceof Error ? err.message : 'Failed to load Trello comments.'
        }))
      } finally {
        if (requestId === requestIdRef.current) {
          setStoredState((state) => ({
            ...stateForCard(state, cardId),
            commentsLoading: false
          }))
        }
      }
    },
    [cardId, fetchTrelloComments]
  )

  const addComment = useCallback(async (): Promise<void> => {
    const body = currentState.commentText.trim()
    if (!body || currentState.commentSubmitting) {
      return
    }
    setStoredState((state) => ({
      ...stateForCard(state, cardId),
      commentSubmitting: true
    }))
    try {
      const result = await addTrelloCardComment(cardId, body)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setStoredState((state) => ({
        ...stateForCard(state, cardId),
        commentText: ''
      }))
      await loadComments({ force: true })
    } finally {
      setStoredState((state) => ({
        ...stateForCard(state, cardId),
        commentSubmitting: false
      }))
    }
  }, [
    addTrelloCardComment,
    cardId,
    currentState.commentSubmitting,
    currentState.commentText,
    loadComments,
    setError
  ])

  return {
    comments: currentState.comments,
    commentsLoading: currentState.commentsLoading,
    commentsError: currentState.commentsError,
    commentText: currentState.commentText,
    commentSubmitting: currentState.commentSubmitting,
    setCommentText,
    loadComments,
    addComment
  }
}
