import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { readRuntimeIssueCommand, writeRuntimeIssueCommand } from '@/runtime/runtime-hooks-client'
import type { ExecutionHostId } from '../../../../shared/execution-host'

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
    let cancelled = false
    let inFlight = false
    let refused: string | null = null
    // Running signals that land while a read is in flight would otherwise be missed.
    let ranDuringRead = new Set<string>()
    updateIssueCommandDraft('')
    setHasSharedIssueCommand(false)
    setIssueCommandSaveError(null)
    setIssueCommandReadOnly(false)
    setIssueCommandStoppedDistro(null)
    contentUnknownRef.current = true
    const load = (): void => {
      inFlight = true
      ranDuringRead = new Set()
      void readRuntimeIssueCommand(selectedHostId, repoId)
        .then((result) => {
          inFlight = false
          if (cancelled) {
            return
          }
          if (result.status === 'error') {
            refused = result.refusedWslDistro?.toLowerCase() ?? null
            setIssueCommandReadOnly(true)
            setIssueCommandStoppedDistro(result.refusedWslDistro ?? null)
            if (refused && ranDuringRead.has(refused)) {
              load()
            }
            return
          }
          refused = null
          const localContent = result.localContent ?? ''
          contentUnknownRef.current = false
          setIssueCommandReadOnly(false)
          setIssueCommandStoppedDistro(null)
          updateIssueCommandDraft(localContent)
          setHasSharedIssueCommand(Boolean(result.sharedContent))
          lastCommittedIssueCommandRef.current = localContent
        })
        .catch(() => {
          inFlight = false
          if (cancelled) {
            return
          }
          // A failed read stays editable, as before; only a refused one is known to hide content.
          contentUnknownRef.current = false
          updateIssueCommandDraft('')
          setHasSharedIssueCommand(false)
          lastCommittedIssueCommandRef.current = ''
        })
    }
    // Subscribed before the read (#35812's pattern): main signals once a refusing distro runs.
    const onDistroRunning = window.api?.preflight?.onWslDistroRunning
    const stopWaiting =
      typeof onDistroRunning === 'function'
        ? onDistroRunning((distro) => {
            const key = distro.toLowerCase()
            if (inFlight) {
              ranDuringRead.add(key)
            } else if (key === refused) {
              refused = null
              load()
            }
          })
        : null
    load()

    return () => {
      cancelled = true
      stopWaiting?.()
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
