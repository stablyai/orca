import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { readRuntimeIssueCommand, writeRuntimeIssueCommand } from '@/runtime/runtime-hooks-client'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { watchRefusedWslRead } from '@/runtime/wsl-refused-read-watch'

export function useRepositoryIssueCommand({
  repoId,
  repoHostIdentity,
  selectedHostId
}: {
  repoId: string
  repoHostIdentity: string
  selectedHostId: ExecutionHostId
}): {
  issueCommandDraft: string
  setIssueCommandDraft: (value: string) => void
  hasSharedIssueCommand: boolean
  issueCommandSaveError: string | null
  /** The host could not read the command, so it is unknown; editing would overwrite it. */
  issueCommandReadOnly: boolean
  /** The stopped WSL distro that kept the command unread (E9). */
  issueCommandStoppedDistro: string | null
  commitIssueCommand: () => Promise<void>
} {
  const [issueCommandDraft, setIssueCommandDraft] = useState('')
  const [hasSharedIssueCommand, setHasSharedIssueCommand] = useState(false)
  const [issueCommandSaveError, setIssueCommandSaveError] = useState<string | null>(null)
  const [issueCommandReadOnly, setIssueCommandReadOnly] = useState(false)
  const [issueCommandStoppedDistro, setIssueCommandStoppedDistro] = useState<string | null>(null)
  const issueCommandDraftRef = useRef(issueCommandDraft)
  const lastCommittedIssueCommandRef = useRef('')
  // Unknown content must never be saved over: an empty draft would delete the hidden override.
  const contentUnknownRef = useRef(true)
  const updateIssueCommandDraft = useCallback((value: string) => {
    issueCommandDraftRef.current = value
    setIssueCommandDraft(value)
  }, [])

  useEffect(() => {
    updateIssueCommandDraft('')
    setHasSharedIssueCommand(false)
    setIssueCommandSaveError(null)
    setIssueCommandReadOnly(false)
    setIssueCommandStoppedDistro(null)
    contentUnknownRef.current = true
    // A refused read is re-asked once its distro runs: main's signal here, a bounded re-poll for a paired host.
    const stopWatching = watchRefusedWslRead({
      hostId: selectedHostId,
      read: () => readRuntimeIssueCommand(selectedHostId, repoId),
      refusedDistro: (result) => (result.status === 'error' ? result.refusedWslDistro : undefined),
      onResult: (result) => {
        if (result.status === 'error') {
          setIssueCommandReadOnly(true)
          setIssueCommandStoppedDistro(result.refusedWslDistro ?? null)
          return
        }
        const localContent = result.localContent ?? ''
        contentUnknownRef.current = false
        setIssueCommandReadOnly(false)
        setIssueCommandStoppedDistro(null)
        updateIssueCommandDraft(localContent)
        setHasSharedIssueCommand(Boolean(result.sharedContent))
        lastCommittedIssueCommandRef.current = localContent
      },
      onError: () => {
        // A failed read stays editable, as before; only a refused one is known to hide content.
        contentUnknownRef.current = false
        updateIssueCommandDraft('')
        setHasSharedIssueCommand(false)
        lastCommittedIssueCommandRef.current = ''
      }
    })

    return () => {
      stopWatching()
      const draft = issueCommandDraftRef.current.trim()
      if (!contentUnknownRef.current && draft !== lastCommittedIssueCommandRef.current) {
        // Saving the user's own edit is a user act: it may start the repo's stopped WSL distro.
        void writeRuntimeIssueCommand(selectedHostId, repoId, draft, { wakeWslDistro: true }).catch(
          (error) => {
            console.error(
              '[RepositoryHooksSection] Failed to save issue command on unmount:',
              error
            )
          }
        )
      }
    }
  }, [repoHostIdentity, repoId, selectedHostId, updateIssueCommandDraft])

  const commitIssueCommand = useCallback(async (): Promise<void> => {
    if (contentUnknownRef.current) {
      return
    }
    const trimmed = issueCommandDraft.trim()
    updateIssueCommandDraft(trimmed)
    // A blur with no edit saves nothing, so it never starts a stopped distro.
    if (trimmed === lastCommittedIssueCommandRef.current) {
      return
    }
    try {
      await writeRuntimeIssueCommand(selectedHostId, repoId, trimmed, { wakeWslDistro: true })
      lastCommittedIssueCommandRef.current = trimmed
      setIssueCommandSaveError(null)
    } catch (error) {
      console.error('[RepositoryHooksSection] Failed to write issue command:', error)
      const message =
        error instanceof Error ? error.message : 'Failed to save GitHub issue command.'
      setIssueCommandSaveError(message)
      toast.error(message)
    }
  }, [issueCommandDraft, repoId, selectedHostId, updateIssueCommandDraft])

  return {
    issueCommandDraft,
    setIssueCommandDraft: updateIssueCommandDraft,
    hasSharedIssueCommand,
    issueCommandSaveError,
    issueCommandReadOnly,
    issueCommandStoppedDistro,
    commitIssueCommand
  }
}
