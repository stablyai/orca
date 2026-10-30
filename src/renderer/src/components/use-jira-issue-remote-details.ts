import { useCallback, useState, useRef, type RefObject } from 'react'
import {
  jiraIssueCommentsForTarget,
  jiraListTransitionsForTarget
} from '@/runtime/runtime-jira-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { JiraComment, JiraIssue, JiraTransition } from '../../../shared/jira/jira-types'
import { translate } from '@/i18n/i18n'

export function useJiraIssueRemoteDetails(
  target: RuntimeClientTarget,
  requestIdRef: RefObject<number>,
  optimisticCommentsRef: RefObject<JiraComment[]>
) {
  const [comments, setComments] = useState<JiraComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [transitions, setTransitions] = useState<JiraTransition[]>([])
  const [transitionsLoading, setTransitionsLoading] = useState(false)
  const [transitionsError, setTransitionsError] = useState<string | null>(null)

  const commentReadIdRef = useRef(0)
  const loadComments = useCallback(
    async (targetIssue: JiraIssue, requestId: number): Promise<void> => {
      if (requestId !== requestIdRef.current) {
        return
      }
      const readId = ++commentReadIdRef.current
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = await jiraIssueCommentsForTarget(target, targetIssue.key, targetIssue.siteId)
        if (requestId !== requestIdRef.current || readId !== commentReadIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.id))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
        }
        setComments(fetched)
      } catch (error) {
        if (requestId === requestIdRef.current && readId === commentReadIdRef.current) {
          setCommentsError(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.jiraIssue.loadCommentsFailed',
                  'Failed to load comments.'
                )
          )
        }
      } finally {
        if (requestId === requestIdRef.current && readId === commentReadIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [target, requestIdRef, optimisticCommentsRef]
  )

  const transitionReadIdRef = useRef(0)
  const loadTransitions = useCallback(
    async (targetIssue: JiraIssue, requestId: number): Promise<void> => {
      if (requestId !== requestIdRef.current) {
        return
      }
      const readId = ++transitionReadIdRef.current
      setTransitionsLoading(true)
      setTransitionsError(null)
      try {
        const result = await jiraListTransitionsForTarget(
          target,
          targetIssue.key,
          targetIssue.siteId
        )
        if (requestId === requestIdRef.current && readId === transitionReadIdRef.current) {
          setTransitions(result)
        }
      } catch (error) {
        if (requestId === requestIdRef.current && readId === transitionReadIdRef.current) {
          setTransitionsError(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.jiraIssue.loadStatusChangesFailed',
                  'Failed to load status changes.'
                )
          )
        }
      } finally {
        if (requestId === requestIdRef.current && readId === transitionReadIdRef.current) {
          setTransitionsLoading(false)
        }
      }
    },
    [target, requestIdRef]
  )

  return {
    comments,
    setComments,
    commentsLoading,
    setCommentsLoading,
    commentsError,
    setCommentsError,
    loadComments,
    transitions,
    setTransitions,
    transitionsLoading,
    setTransitionsLoading,
    transitionsError,
    setTransitionsError,
    loadTransitions
  }
}
