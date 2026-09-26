import { useCallback, type RefObject } from 'react'
import { toast } from 'sonner'
import { businessmapUpdateCard } from '@/runtime/runtime-businessmap-client'
import type { BusinessmapCard } from '../../../shared/businessmap-types'
import type { RuntimeBusinessmapSettings } from '@/runtime/runtime-businessmap-target'
import { translate } from '@/i18n/i18n'

type MutationInputs = {
  displayed: BusinessmapCard | null
  pendingField: string | null
  providerSettings: RuntimeBusinessmapSettings
  titleDraft: string
  descriptionDraft: string
  requestIdRef: RefObject<number>
  setFullCard: (card: BusinessmapCard | null) => void
  setPendingField: (field: string | null) => void
}

// Why: title/description saves share one guarded mutation shape; the drawer keeps the callbacks.
export function useBusinessmapCardMutations(inputs: MutationInputs): {
  handleSaveTitle: () => void
  handleSaveDescription: () => void
} {
  const {
    displayed,
    pendingField,
    providerSettings,
    titleDraft,
    descriptionDraft,
    requestIdRef,
    setFullCard,
    setPendingField
  } = inputs

  const runFieldMutation = useCallback(
    (field: 'title' | 'description', value: string) => {
      if (!displayed || pendingField) {
        return
      }
      setPendingField(field)
      setFullCard({ ...displayed, [field]: value })
      const requestId = requestIdRef.current
      void businessmapUpdateCard(providerSettings, displayed.id, { [field]: value })
        .then((result) => {
          if (!result.ok) {
            throw new Error(result.error)
          }
        })
        .catch((error) => {
          if (requestId !== requestIdRef.current) {
            return
          }
          setFullCard(displayed)
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.BusinessmapCardWorkspace.updateFailed',
                  'Failed to update card.'
                )
          )
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setPendingField(null)
          }
        })
    },
    [displayed, pendingField, providerSettings, requestIdRef, setFullCard, setPendingField]
  )

  const handleSaveTitle = useCallback(() => {
    if (!displayed || pendingField) {
      return
    }
    const title = titleDraft.trim()
    if (!title || title === displayed.title) {
      return
    }
    runFieldMutation('title', title)
  }, [displayed, pendingField, runFieldMutation, titleDraft])

  const handleSaveDescription = useCallback(() => {
    if (!displayed || pendingField) {
      return
    }
    const description = descriptionDraft.trim()
    if ((displayed.description ?? '') === description) {
      return
    }
    runFieldMutation('description', description)
  }, [descriptionDraft, displayed, pendingField, runFieldMutation])

  return { handleSaveTitle, handleSaveDescription }
}
