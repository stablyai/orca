import { useEffect, useRef, useState } from 'react'
import type { JiraComment, JiraIssue, JiraPriority } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { jiraGetIssueForTarget, jiraListPrioritiesForTarget } from '@/runtime/runtime-jira-client'
import {
  mergeJiraIssueHydration,
  type EditableJiraIssueField
} from './jira-issue-workspace-hydration'
import { useJiraIssueRemoteDetails } from './use-jira-issue-remote-details'

type JiraIssueWorkspaceDataArgs = {
  issue: JiraIssue | null
  owner: RuntimeClientTarget
  requestKey: string | null
}

export function useJiraIssueWorkspaceData({
  issue,
  owner,
  requestKey
}: JiraIssueWorkspaceDataArgs) {
  const [fullIssue, setFullIssue] = useState<JiraIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [priorities, setPriorities] = useState<JiraPriority[]>([])
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [labelsDraft, setLabelsDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const requestIdRef = useRef(0)
  const optimisticCommentsRef = useRef<JiraComment[]>([])
  const editedFieldsRef = useRef(new Set<EditableJiraIssueField>())
  const remoteDetails = useJiraIssueRemoteDetails(owner, requestIdRef, optimisticCommentsRef)
  const {
    loadComments,
    loadTransitions,
    setComments,
    setCommentsError,
    setCommentsLoading,
    setTransitions,
    setTransitionsError,
    setTransitionsLoading
  } = remoteDetails
  const loadedRequestKeyRef = useRef<string | null>(null)

  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: seeds editable issue drafts while IPC hydration runs and invalidates obsolete requests.
  useEffect(() => {
    if (issue && loadedRequestKeyRef.current === requestKey) {
      return
    }
    loadedRequestKeyRef.current = requestKey
    requestIdRef.current += 1
    setPendingField(null)
    setCommentSubmitting(false)
    setCommentDraft('')
    if (!issue) {
      setFullIssue(null)
      setIssueLoading(false)
      setComments([])
      setCommentsLoading(false)
      setCommentsError(null)
      setTransitions([])
      setTransitionsError(null)
      setTransitionsLoading(false)
      setPriorities([])
      optimisticCommentsRef.current = []
      return
    }

    const requestId = requestIdRef.current
    optimisticCommentsRef.current = []
    editedFieldsRef.current = new Set()
    setFullIssue(issue)
    setTitleDraft(issue.title)
    setLabelsDraft(issue.labels.join(', '))
    setComments([])
    setCommentsError(null)
    setTransitions([])
    setTransitionsError(null)
    setIssueLoading(true)

    void jiraGetIssueForTarget(owner, issue.key, issue.siteId)
      .then((result) => {
        if (requestId !== requestIdRef.current || !result) {
          return
        }
        const edited = new Set(editedFieldsRef.current)
        setFullIssue((current) => mergeJiraIssueHydration(result, current, edited))
        if (!edited.has('title')) {
          setTitleDraft(result.title)
        }
        if (!edited.has('labels')) {
          setLabelsDraft(result.labels.join(', '))
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setIssueLoading(false)
        }
      })

    void jiraListPrioritiesForTarget(owner, issue.siteId)
      .then((nextPriorities) => {
        if (requestId === requestIdRef.current) {
          setPriorities(nextPriorities)
        }
      })
      .catch(() => {})

    void loadTransitions(issue, requestId)
    void loadComments(issue, requestId)
  }, [
    issue,
    loadComments,
    loadTransitions,
    owner,
    requestKey,
    setComments,
    setCommentsError,
    setCommentsLoading,
    setTransitions,
    setTransitionsError,
    setTransitionsLoading
  ])

  useEffect(
    () => () => {
      requestIdRef.current += 1
      loadedRequestKeyRef.current = null
    },
    []
  )

  return {
    ...remoteDetails,
    commentDraft,
    commentSubmitting,
    editedFieldsRef,
    fullIssue,
    issueLoading,
    labelsDraft,
    optimisticCommentsRef,
    pendingField,
    priorities,
    requestIdRef,
    setCommentDraft,
    setCommentSubmitting,
    setFullIssue,
    setLabelsDraft,
    setPendingField,
    setPriorities,
    setTitleDraft,
    titleDraft
  }
}
