import { useCallback, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import type {
  TrelloCard,
  TrelloLabel,
  TrelloList,
  TrelloMember
} from '../../../shared/trello-types'
import type { GlobalSettings } from '../../../shared/types'
import { trelloUpdateCard } from '@/runtime/runtime-trello-client'
import { saveTrelloCardChanges } from '@/components/trello-card-detail-save'
import { prepareTrelloDescriptionForSave } from '@/lib/trello-description-images'

export type DirtyTrelloCardDetailFields = {
  title: boolean
  description: boolean
  listId: boolean
}

type FetchTrelloCard = (cardId: string, options?: { force?: boolean }) => Promise<TrelloCard | null>

type ApplyFreshCard = (card: TrelloCard, options?: { notifyParent?: boolean }) => void

type TrelloCardDetailMutationActionsArgs = {
  settings: GlobalSettings | null | undefined
  displayed: TrelloCard
  title: string
  description: string
  listId: string
  lists: TrelloList[]
  boardMembers: TrelloMember[]
  boardLabels: TrelloLabel[]
  savingRef: MutableRefObject<boolean>
  dirtyFieldsRef: MutableRefObject<DirtyTrelloCardDetailFields>
  setSaving: (value: boolean) => void
  setError: (value: string | null) => void
  setListId: (value: string) => void
  fetchTrelloCard: FetchTrelloCard
  applyFreshCard: ApplyFreshCard
  applyUpdatedCard: (card: TrelloCard) => void
}

export type TrelloCardDetailMutationActions = {
  onDescriptionSave: (value: string) => Promise<void>
  onSave: () => Promise<void>
  onArchiveToggle: () => Promise<void>
  onListChange: (listId: string) => Promise<void>
  onMemberToggle: (memberId: string) => Promise<void>
  onLabelToggle: (labelId: string) => Promise<void>
}

export function useTrelloCardDetailMutationActions({
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
}: TrelloCardDetailMutationActionsArgs): TrelloCardDetailMutationActions {
  const handleSave = useCallback(async (): Promise<void> => {
    if (savingRef.current) {
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const updatedCard = await saveTrelloCardChanges({
        settings,
        cardId: displayed.id,
        title,
        description,
        listId,
        fetchTrelloCard
      })
      if (updatedCard) {
        applyUpdatedCard(updatedCard)
        toast.success('Trello card updated')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update Trello card.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [
    applyUpdatedCard,
    description,
    displayed.id,
    fetchTrelloCard,
    listId,
    savingRef,
    setError,
    setSaving,
    settings,
    title
  ])

  const handleDescriptionSave = useCallback(
    async (nextDescription: string): Promise<void> => {
      if (nextDescription === displayed.desc) {
        return
      }
      if (savingRef.current) {
        return
      }
      savingRef.current = true
      setSaving(true)
      setError(null)
      try {
        const preparedDescription = await prepareTrelloDescriptionForSave({
          cardId: displayed.id,
          description: nextDescription,
          settings
        })
        const result = await trelloUpdateCard(settings, displayed.id, { desc: preparedDescription })
        if (!result.ok) {
          setError(result.error)
          return
        }
        dirtyFieldsRef.current.description = false
        const updatedCard = await fetchTrelloCard(displayed.id, { force: true })
        if (updatedCard) {
          applyFreshCard(updatedCard)
        } else {
          applyFreshCard({ ...displayed, desc: preparedDescription })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update Trello description.')
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [
      applyFreshCard,
      dirtyFieldsRef,
      displayed,
      fetchTrelloCard,
      savingRef,
      setError,
      setSaving,
      settings
    ]
  )

  const handleArchiveToggle = useCallback(async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const result = await trelloUpdateCard(settings, displayed.id, { closed: !displayed.closed })
      if (!result.ok) {
        setError(result.error)
        return
      }
      applyFreshCard({ ...displayed, closed: !displayed.closed }, { notifyParent: true })
      const fresh = await fetchTrelloCard(displayed.id, { force: true })
      if (fresh) {
        applyFreshCard(fresh, { notifyParent: true })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update archived state.')
    } finally {
      setSaving(false)
    }
  }, [applyFreshCard, displayed, fetchTrelloCard, setError, setSaving, settings])

  const handleListChange = useCallback(
    async (nextListId: string): Promise<void> => {
      setListId(nextListId)
      dirtyFieldsRef.current.listId = true
      setSaving(true)
      setError(null)
      try {
        const result = await trelloUpdateCard(settings, displayed.id, { idList: nextListId })
        if (!result.ok) {
          setError(result.error)
          return
        }
        const optimistic = {
          ...displayed,
          idList: nextListId,
          listName: lists.find((list) => list.id === nextListId)?.name ?? displayed.listName
        }
        applyFreshCard(optimistic, { notifyParent: true })
        dirtyFieldsRef.current.listId = false
        const fresh = await fetchTrelloCard(displayed.id, { force: true })
        if (fresh) {
          applyFreshCard(fresh, { notifyParent: true })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update Trello list.')
      } finally {
        setSaving(false)
      }
    },
    [
      applyFreshCard,
      dirtyFieldsRef,
      displayed,
      fetchTrelloCard,
      lists,
      setError,
      setListId,
      setSaving,
      settings
    ]
  )

  const handleMemberToggle = useCallback(
    async (memberId: string): Promise<void> => {
      const currentIds = displayed.members.map((member) => member.id)
      const nextIds = currentIds.includes(memberId)
        ? currentIds.filter((id) => id !== memberId)
        : [...currentIds, memberId]
      setSaving(true)
      setError(null)
      try {
        const result = await trelloUpdateCard(settings, displayed.id, { idMembers: nextIds })
        if (!result.ok) {
          setError(result.error)
          return
        }
        applyFreshCard(
          {
            ...displayed,
            members: boardMembers.filter((member) => nextIds.includes(member.id))
          },
          { notifyParent: true }
        )
        const fresh = await fetchTrelloCard(displayed.id, { force: true })
        if (fresh) {
          applyFreshCard(fresh, { notifyParent: true })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update Trello members.')
      } finally {
        setSaving(false)
      }
    },
    [applyFreshCard, boardMembers, displayed, fetchTrelloCard, setError, setSaving, settings]
  )

  const handleLabelToggle = useCallback(
    async (labelId: string): Promise<void> => {
      const currentIds = displayed.labels.map((label) => label.id)
      const nextIds = currentIds.includes(labelId)
        ? currentIds.filter((id) => id !== labelId)
        : [...currentIds, labelId]
      setSaving(true)
      setError(null)
      try {
        const result = await trelloUpdateCard(settings, displayed.id, { idLabels: nextIds })
        if (!result.ok) {
          setError(result.error)
          return
        }
        applyFreshCard(
          {
            ...displayed,
            labels: boardLabels.filter((label) => nextIds.includes(label.id))
          },
          { notifyParent: true }
        )
        const fresh = await fetchTrelloCard(displayed.id, { force: true })
        if (fresh) {
          applyFreshCard(fresh, { notifyParent: true })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update Trello labels.')
      } finally {
        setSaving(false)
      }
    },
    [applyFreshCard, boardLabels, displayed, fetchTrelloCard, setError, setSaving, settings]
  )

  return {
    onDescriptionSave: handleDescriptionSave,
    onSave: handleSave,
    onArchiveToggle: handleArchiveToggle,
    onListChange: handleListChange,
    onMemberToggle: handleMemberToggle,
    onLabelToggle: handleLabelToggle
  }
}
