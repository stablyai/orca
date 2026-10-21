import type { ComposerModel } from './composer-model'

type MultipleCreateResetInput = Pick<
  ComposerModel,
  | 'handleClearSmartNameSelection'
  | 'lastAutoNameRef'
  | 'nameInputRef'
  | 'setAgentPrompt'
  | 'setAttachmentPaths'
  | 'setCreateError'
  | 'setName'
  | 'setNote'
  | 'setTagDraft'
>

import { useCallback } from 'react'

export function useMultipleCreateReset(input: MultipleCreateResetInput) {
  const {
    handleClearSmartNameSelection,
    lastAutoNameRef,
    nameInputRef,
    setAgentPrompt,
    setAttachmentPaths,
    setCreateError,
    setName,
    setNote,
    setTagDraft
  } = input
  const resetForNextCreate = useCallback(() => {
    // Clear the checkout source too, so a PR's resolved SHA cannot become the next selection.
    handleClearSmartNameSelection()
    setName('')
    lastAutoNameRef.current = ''
    setAgentPrompt('')
    setNote('')
    // Why keep tags: a batch of workspaces for one task usually shares them.
    setTagDraft('')
    setAttachmentPaths([])
    setCreateError(null)
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [
    handleClearSmartNameSelection,
    lastAutoNameRef,
    nameInputRef,
    setAgentPrompt,
    setAttachmentPaths,
    setCreateError,
    setName,
    setNote,
    setTagDraft
  ])

  return {
    resetForNextCreate
  }
}
