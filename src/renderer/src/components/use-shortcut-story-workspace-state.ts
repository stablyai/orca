/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Shortcut story hydration,
   comments, workflow states, and member options are loaded from provider IPC for the selected story. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import {
  shortcutGetStory,
  shortcutListMembers,
  shortcutListWorkflows,
  shortcutUpdateStory
} from '@/runtime/runtime-shortcut-client'
import {
  useShortcutStoryComments,
  type ShortcutStoryCommentsState
} from '@/components/use-shortcut-story-comments'
import type {
  ShortcutMember,
  ShortcutStory,
  ShortcutStoryUpdate,
  ShortcutWorkflow,
  ShortcutWorkflowState
} from '../../../shared/shortcut-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'

export type ShortcutStoryWorkspaceState = {
  displayed: ShortcutStory | null
  storyLoading: boolean
  comments: ShortcutStoryCommentsState['comments']
  commentsLoading: boolean
  commentsError: string | null
  reloadComments: () => void
  workflowStates: ShortcutWorkflowState[]
  members: ShortcutMember[]
  pendingField: string | null
  titleDraft: string
  setTitleDraft: (value: string) => void
  labelsDraft: string
  setLabelsDraft: (value: string) => void
  commentDraft: string
  setCommentDraft: (value: string) => void
  commentSubmitting: boolean
  canSubmitComment: boolean
  submitComment: () => Promise<void>
  mutateStory: (
    field: string,
    updates: ShortcutStoryUpdate,
    optimistic?: Partial<ShortcutStory>
  ) => Promise<void>
  saveTitle: () => void
  saveLabels: () => void
}

function statesForStory(
  workflows: ShortcutWorkflow[],
  story: ShortcutStory | null
): ShortcutWorkflowState[] {
  if (!story) {
    return []
  }
  const workflow = workflows.find((candidate) => candidate.id === story.workflowId)
  if (workflow) {
    return workflow.states
  }
  // Fallback: the state id alone can locate the owning workflow when the
  // story predates workflowId denormalization.
  return (
    workflows.find((candidate) => candidate.states.some((state) => state.id === story.state.id))
      ?.states ?? []
  )
}

export function useShortcutStoryWorkspaceState(
  story: ShortcutStory | null,
  sourceContext?: TaskSourceContext | null
): ShortcutStoryWorkspaceState {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const patchShortcutStory = useAppStore((s) => s.patchShortcutStory)
  const [fullStory, setFullStory] = useState<ShortcutStory | null>(null)
  const [storyLoading, setStoryLoading] = useState(false)
  const [workflows, setWorkflows] = useState<ShortcutWorkflow[]>([])
  const [members, setMembers] = useState<ShortcutMember[]>([])
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [labelsDraft, setLabelsDraft] = useState('')
  const requestIdRef = useRef(0)
  const commentsState = useShortcutStoryComments(providerSettings, requestIdRef)
  const { loadComments, resetComments } = commentsState

  const displayed = fullStory ?? story
  const workspaceId = displayed?.workspaceId ?? undefined

  useEffect(() => {
    if (!story) {
      setFullStory(null)
      setStoryLoading(false)
      setWorkflows([])
      setMembers([])
      resetComments()
      return
    }

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    resetComments()
    setFullStory(story)
    setTitleDraft(story.title)
    setLabelsDraft(story.labels.join(', '))
    setStoryLoading(true)

    void shortcutGetStory(providerSettings, story.id, story.workspaceId)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          setFullStory(result)
          setTitleDraft(result.title)
          setLabelsDraft(result.labels.join(', '))
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setStoryLoading(false)
        }
      })

    void Promise.all([
      shortcutListWorkflows(providerSettings, story.workspaceId),
      shortcutListMembers(providerSettings, story.workspaceId)
    ])
      .then(([nextWorkflows, nextMembers]) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setWorkflows(nextWorkflows)
        setMembers(nextMembers)
      })
      .catch(() => {})

    void loadComments(story, requestId)
  }, [story, loadComments, resetComments, providerSettings])

  const refreshStory = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    try {
      const latest = await shortcutGetStory(providerSettings, displayed.id, displayed.workspaceId)
      if (latest) {
        setFullStory(latest)
        patchShortcutStory(latest.id, latest, { sourceContext })
      }
    } catch {
      // Keep the visible story snapshot if refresh fails.
    }
  }, [displayed, patchShortcutStory, providerSettings, sourceContext])

  const mutateStory = useCallback(
    async (
      field: string,
      updates: ShortcutStoryUpdate,
      optimistic?: Partial<ShortcutStory>
    ): Promise<void> => {
      if (!displayed || pendingField) {
        return
      }
      setPendingField(field)
      const previous = displayed
      try {
        if (optimistic) {
          setFullStory({ ...displayed, ...optimistic })
          patchShortcutStory(displayed.id, optimistic, { sourceContext })
        }
        const result = await shortcutUpdateStory(
          providerSettings,
          displayed.id,
          updates,
          workspaceId
        )
        if (!result.ok) {
          throw new Error(result.error)
        }
        await refreshStory()
      } catch (error) {
        setFullStory(previous)
        patchShortcutStory(previous.id, previous, { sourceContext })
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.ShortcutStoryWorkspace.updateFailed',
                'Failed to update Shortcut story.'
              )
        )
      } finally {
        setPendingField(null)
      }
    },
    [
      displayed,
      patchShortcutStory,
      pendingField,
      refreshStory,
      providerSettings,
      workspaceId,
      sourceContext
    ]
  )

  const saveTitle = useCallback(() => {
    if (!displayed) {
      return
    }
    const title = titleDraft.trim()
    if (!title || title === displayed.title) {
      setTitleDraft(displayed.title)
      return
    }
    void mutateStory('title', { title }, { title })
  }, [displayed, mutateStory, titleDraft])

  const saveLabels = useCallback(() => {
    if (!displayed) {
      return
    }
    const labels = labelsDraft
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
    void mutateStory('labels', { labels }, { labels })
  }, [displayed, labelsDraft, mutateStory])

  return {
    displayed,
    storyLoading,
    comments: commentsState.comments,
    commentsLoading: commentsState.commentsLoading,
    commentsError: commentsState.commentsError,
    reloadComments: () => {
      if (displayed) {
        void loadComments(displayed, requestIdRef.current)
      }
    },
    workflowStates: statesForStory(workflows, displayed),
    members,
    pendingField,
    titleDraft,
    setTitleDraft,
    labelsDraft,
    setLabelsDraft,
    commentDraft: commentsState.commentDraft,
    setCommentDraft: commentsState.setCommentDraft,
    commentSubmitting: commentsState.commentSubmitting,
    canSubmitComment: commentsState.canSubmitComment,
    submitComment: () => commentsState.submitComment(displayed),
    mutateStory,
    saveTitle,
    saveLabels
  }
}
