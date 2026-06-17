import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TrelloCard,
  TrelloComment,
  TrelloLabel,
  TrelloList,
  TrelloMember
} from '../../../shared/trello-types'
import { useAppStore } from '@/store'
import { createTrelloCardDetailActionItems } from '@/components/trello-card-detail-actions'
import { loadTrelloCardDetailData } from '@/components/trello-card-detail-data'
import { useTrelloCardDetailComments } from '@/components/trello-card-detail-comments'
import {
  useTrelloCardDetailMutationActions,
  type DirtyTrelloCardDetailFields
} from '@/components/trello-card-detail-mutation-actions'
import { renderCardContext } from '@/components/trello-card-detail-text'
import type { TrelloCardDetailActionItem } from '@/components/trello-card-detail-sidebar'
import type { RichMarkdownImageSrcResolver } from '@/components/editor/rich-markdown-extensions'
import { createTrelloImageSrcResolver } from '@/lib/trello-authenticated-images'

type TrelloCardDetailControllerArgs = {
  card: TrelloCard
  onUpdated: (card: TrelloCard) => void
}

export type TrelloCardDetailController = {
  displayed: TrelloCard
  title: string
  description: string
  listId: string
  lists: TrelloList[]
  boardMembers: TrelloMember[]
  boardLabels: TrelloLabel[]
  loading: boolean
  saving: boolean
  error: string | null
  dirty: boolean
  comments: TrelloComment[]
  commentsLoading: boolean
  commentsError: string | null
  commentText: string
  commentSubmitting: boolean
  renderedContext: string
  actionItems: TrelloCardDetailActionItem[]
  resolveTrelloImageSrc: RichMarkdownImageSrcResolver
  setCommentText: (value: string) => void
  onTitleChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onDescriptionSave: (value: string) => Promise<void>
  onSave: () => Promise<void>
  onArchiveToggle: () => Promise<void>
  onListChange: (listId: string) => Promise<void>
  onMemberToggle: (memberId: string) => Promise<void>
  onLabelToggle: (labelId: string) => Promise<void>
  onRetryComments: (options?: { force?: boolean }) => Promise<void>
  onAddComment: () => Promise<void>
}

const cleanDirtyFields = (): DirtyTrelloCardDetailFields => ({
  title: false,
  description: false,
  listId: false
})

export function useTrelloCardDetailController({
  card,
  onUpdated
}: TrelloCardDetailControllerArgs): TrelloCardDetailController {
  const settings = useAppStore((s) => s.settings)
  const fetchTrelloCard = useAppStore((s) => s.fetchTrelloCard)
  const fetchTrelloLists = useAppStore((s) => s.fetchTrelloLists)
  const fetchTrelloBoardMembers = useAppStore((s) => s.fetchTrelloBoardMembers)
  const fetchTrelloBoardLabels = useAppStore((s) => s.fetchTrelloBoardLabels)
  const patchTrelloCard = useAppStore((s) => s.patchTrelloCard)
  const trelloStatus = useAppStore((s) => s.trelloStatus)

  const [displayed, setDisplayed] = useState(card)
  const [title, setTitle] = useState(card.name)
  const [description, setDescription] = useState(card.desc)
  const [listId, setListId] = useState(card.idList)
  const [lists, setLists] = useState<TrelloList[]>([])
  const [boardMembers, setBoardMembers] = useState<TrelloMember[]>([])
  const [boardLabels, setBoardLabels] = useState<TrelloLabel[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirtyFieldsRef = useRef(cleanDirtyFields())
  const prevCardIdRef = useRef(card.id)
  const loadRequestIdRef = useRef(0)
  const savingRef = useRef(false)

  const resolveTrelloImageSrc = useMemo(
    () =>
      createTrelloImageSrcResolver(settings, {
        runtimeEnvironmentId: settings?.activeRuntimeEnvironmentId,
        accountId: trelloStatus.viewer?.username
      }),
    [settings, trelloStatus.viewer?.username]
  )

  const dirty = useMemo(
    () => title !== displayed.name || description !== displayed.desc || listId !== displayed.idList,
    [description, displayed.desc, displayed.idList, displayed.name, listId, title]
  )

  const applyFreshCard = useCallback(
    (nextCard: TrelloCard, options?: { notifyParent?: boolean }): void => {
      setDisplayed(nextCard)
      if (!dirtyFieldsRef.current.title) {
        setTitle(nextCard.name)
      }
      if (!dirtyFieldsRef.current.description) {
        setDescription(nextCard.desc)
      }
      if (!dirtyFieldsRef.current.listId) {
        setListId(nextCard.idList)
      }
      patchTrelloCard(nextCard.id, nextCard)
      if (options?.notifyParent === true) {
        onUpdated(nextCard)
      }
    },
    [onUpdated, patchTrelloCard]
  )

  const applyUpdatedCard = useCallback(
    (updated: TrelloCard): void => {
      dirtyFieldsRef.current = cleanDirtyFields()
      setDisplayed(updated)
      setTitle(updated.name)
      setDescription(updated.desc)
      setListId(updated.idList)
      patchTrelloCard(updated.id, updated)
      onUpdated(updated)
    },
    [onUpdated, patchTrelloCard]
  )

  const loadDetails = useCallback(async (): Promise<void> => {
    const requestId = ++loadRequestIdRef.current
    setLoading(true)
    setError(null)
    try {
      const nextData = await loadTrelloCardDetailData({
        card,
        fetchTrelloCard,
        fetchTrelloLists,
        fetchTrelloBoardMembers,
        fetchTrelloBoardLabels
      })
      if (requestId !== loadRequestIdRef.current) {
        return
      }
      applyFreshCard(nextData.card)
      setLists(nextData.lists)
      setBoardMembers(nextData.boardMembers)
      setBoardLabels(nextData.boardLabels)
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) {
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to load Trello card.')
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false)
      }
    }
  }, [
    applyFreshCard,
    card,
    fetchTrelloBoardLabels,
    fetchTrelloBoardMembers,
    fetchTrelloCard,
    fetchTrelloLists
  ])

  const {
    comments,
    commentsLoading,
    commentsError,
    commentText,
    commentSubmitting,
    setCommentText,
    loadComments,
    addComment
  } = useTrelloCardDetailComments({ cardId: card.id, setError })

  useEffect(() => {
    const cardIdChanged = card.id !== prevCardIdRef.current
    if (cardIdChanged) {
      prevCardIdRef.current = card.id
      dirtyFieldsRef.current = cleanDirtyFields()
      setDisplayed(card)
      setTitle(card.name)
      setDescription(card.desc)
      setListId(card.idList)
    } else {
      setDisplayed(card)
      if (!dirtyFieldsRef.current.title) {
        setTitle(card.name)
      }
      if (!dirtyFieldsRef.current.description) {
        setDescription(card.desc)
      }
      if (!dirtyFieldsRef.current.listId) {
        setListId(card.idList)
      }
    }
    void loadDetails()
    void loadComments({ force: true })
  }, [card, loadComments, loadDetails])

  const handleTitleChange = useCallback(
    (nextValue: string): void => {
      dirtyFieldsRef.current.title = nextValue !== displayed.name
      setTitle(nextValue)
    },
    [displayed.name]
  )

  const handleDescriptionChange = useCallback(
    (value: string): void => {
      dirtyFieldsRef.current.description = value !== displayed.desc
      setDescription(value)
    },
    [displayed.desc]
  )

  const mutationActions = useTrelloCardDetailMutationActions({
    settings,
    displayed,
    title,
    description,
    listId,
    lists,
    boardMembers,
    boardLabels,
    savingRef,
    dirtyFieldsRef,
    setSaving,
    setError,
    setListId,
    fetchTrelloCard,
    applyFreshCard,
    applyUpdatedCard
  })

  const renderedContext = renderCardContext(displayed)
  const actionItems = createTrelloCardDetailActionItems(displayed, renderedContext)

  return {
    displayed,
    title,
    description,
    listId,
    lists,
    boardMembers,
    boardLabels,
    loading,
    saving,
    error,
    dirty,
    comments,
    commentsLoading,
    commentsError,
    commentText,
    commentSubmitting,
    renderedContext,
    actionItems,
    resolveTrelloImageSrc,
    setCommentText,
    onTitleChange: handleTitleChange,
    onDescriptionChange: handleDescriptionChange,
    ...mutationActions,
    onRetryComments: loadComments,
    onAddComment: addComment
  }
}
