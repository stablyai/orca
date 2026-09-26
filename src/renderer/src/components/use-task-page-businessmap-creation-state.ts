import type { TaskPageJiraCreationMetadataModel } from './use-task-page-jira-creation-metadata'
import { useState } from 'react'
import type { BusinessmapBoard } from '../../../shared/businessmap-types'
import { useTaskCreationDraftRetention } from '@/components/use-task-creation-draft-retention'
import { writeNewBusinessmapCardDraft } from './task-page-draft-storage'
import { useAppStore } from '@/store'

export function useTaskPageBusinessmapCreationState(model: TaskPageJiraCreationMetadataModel) {
  const newBusinessmapCardDraft = useAppStore((s) => s.newBusinessmapCardDraft)
  const [newBusinessmapCardOpen, setNewBusinessmapCardOpen] = useState(false)
  const [newBusinessmapCardTitle, setNewBusinessmapCardTitle] = useState(
    newBusinessmapCardDraft?.title ?? ''
  )
  const [newBusinessmapCardBody, setNewBusinessmapCardBody] = useState(
    newBusinessmapCardDraft?.body ?? ''
  )
  const [newBusinessmapCardBoardId, setNewBusinessmapCardBoardId] = useState<number | null>(null)
  const [newBusinessmapCardSubmitting, setNewBusinessmapCardSubmitting] = useState(false)
  const [availableBusinessmapBoards, setAvailableBusinessmapBoards] = useState<BusinessmapBoard[]>(
    []
  )
  const [businessmapBoardsLoading, setBusinessmapBoardsLoading] = useState(false)
  const defaultBusinessmapBoardId =
    newBusinessmapCardOpen && newBusinessmapCardBoardId === null
      ? (availableBusinessmapBoards[0]?.id ?? null)
      : newBusinessmapCardBoardId
  const discardNewBusinessmapCardDraft = useTaskCreationDraftRetention({
    open: newBusinessmapCardOpen,
    draft: { title: newBusinessmapCardTitle, body: newBusinessmapCardBody },
    writeDraft: writeNewBusinessmapCardDraft
  })
  const nextModel = model as typeof model & {
    newBusinessmapCardOpen: typeof newBusinessmapCardOpen
    setNewBusinessmapCardOpen: typeof setNewBusinessmapCardOpen
    newBusinessmapCardTitle: typeof newBusinessmapCardTitle
    setNewBusinessmapCardTitle: typeof setNewBusinessmapCardTitle
    newBusinessmapCardBody: typeof newBusinessmapCardBody
    setNewBusinessmapCardBody: typeof setNewBusinessmapCardBody
    newBusinessmapCardBoardId: typeof newBusinessmapCardBoardId
    setNewBusinessmapCardBoardId: typeof setNewBusinessmapCardBoardId
    newBusinessmapCardSubmitting: typeof newBusinessmapCardSubmitting
    setNewBusinessmapCardSubmitting: typeof setNewBusinessmapCardSubmitting
    availableBusinessmapBoards: typeof availableBusinessmapBoards
    setAvailableBusinessmapBoards: typeof setAvailableBusinessmapBoards
    businessmapBoardsLoading: typeof businessmapBoardsLoading
    setBusinessmapBoardsLoading: typeof setBusinessmapBoardsLoading
    discardNewBusinessmapCardDraft: typeof discardNewBusinessmapCardDraft
  }
  nextModel.newBusinessmapCardOpen = newBusinessmapCardOpen
  nextModel.setNewBusinessmapCardOpen = setNewBusinessmapCardOpen
  nextModel.newBusinessmapCardTitle = newBusinessmapCardTitle
  nextModel.setNewBusinessmapCardTitle = setNewBusinessmapCardTitle
  nextModel.newBusinessmapCardBody = newBusinessmapCardBody
  nextModel.setNewBusinessmapCardBody = setNewBusinessmapCardBody
  nextModel.newBusinessmapCardBoardId = defaultBusinessmapBoardId
  nextModel.setNewBusinessmapCardBoardId = setNewBusinessmapCardBoardId
  nextModel.newBusinessmapCardSubmitting = newBusinessmapCardSubmitting
  nextModel.setNewBusinessmapCardSubmitting = setNewBusinessmapCardSubmitting
  nextModel.availableBusinessmapBoards = availableBusinessmapBoards
  nextModel.setAvailableBusinessmapBoards = setAvailableBusinessmapBoards
  nextModel.businessmapBoardsLoading = businessmapBoardsLoading
  nextModel.setBusinessmapBoardsLoading = setBusinessmapBoardsLoading
  nextModel.discardNewBusinessmapCardDraft = discardNewBusinessmapCardDraft
  return nextModel
}

export type TaskPageBusinessmapCreationStateModel = ReturnType<
  typeof useTaskPageBusinessmapCreationState
>
