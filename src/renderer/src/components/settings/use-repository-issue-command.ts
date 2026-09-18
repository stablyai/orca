import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { readRuntimeIssueCommand, writeRuntimeIssueCommand } from '@/runtime/runtime-hooks-client'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RepoCommandKind } from '../../../../shared/repo-command-kind'

type HookRuntimeSettings = { activeRuntimeEnvironmentId: string | null }

export function useRepositoryIssueCommand({
  hookRuntimeSettings,
  repoId,
  repoHostIdentity,
  selectedHostId,
  kind = 'issue'
}: {
  hookRuntimeSettings: HookRuntimeSettings
  repoId: string
  repoHostIdentity: string
  selectedHostId: ExecutionHostId
  kind?: RepoCommandKind
}): {
  issueCommandDraft: string
  setIssueCommandDraft: (value: string) => void
  hasSharedIssueCommand: boolean
  issueCommandSaveError: string | null
  commitIssueCommand: () => Promise<void>
} {
  const [issueCommandDraft, setIssueCommandDraft] = useState('')
  const [hasSharedIssueCommand, setHasSharedIssueCommand] = useState(false)
  const [issueCommandSaveError, setIssueCommandSaveError] = useState<string | null>(null)
  const issueCommandDraftRef = useRef(issueCommandDraft)
  const lastCommittedIssueCommandRef = useRef('')
  const updateIssueCommandDraft = useCallback((value: string) => {
    issueCommandDraftRef.current = value
    setIssueCommandDraft(value)
  }, [])

  useEffect(() => {
    let cancelled = false
    updateIssueCommandDraft('')
    setHasSharedIssueCommand(false)
    setIssueCommandSaveError(null)
    void readRuntimeIssueCommand(hookRuntimeSettings, repoId, selectedHostId, kind)
      .then((result) => {
        if (cancelled) {
          return
        }
        const localContent = result.localContent ?? ''
        updateIssueCommandDraft(localContent)
        setHasSharedIssueCommand(Boolean(result.sharedContent))
        lastCommittedIssueCommandRef.current = localContent
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        updateIssueCommandDraft('')
        setHasSharedIssueCommand(false)
        lastCommittedIssueCommandRef.current = ''
      })

    return () => {
      cancelled = true
      const draft = issueCommandDraftRef.current.trim()
      if (draft !== lastCommittedIssueCommandRef.current) {
        void writeRuntimeIssueCommand(
          hookRuntimeSettings,
          repoId,
          draft,
          selectedHostId,
          kind
        ).catch((error) => {
          console.error(
            `[RepositoryHooksSection] Failed to save ${kind} command on unmount:`,
            error
          )
        })
      }
    }
  }, [hookRuntimeSettings, kind, repoHostIdentity, repoId, selectedHostId, updateIssueCommandDraft])

  const commitIssueCommand = useCallback(async (): Promise<void> => {
    const trimmed = issueCommandDraft.trim()
    updateIssueCommandDraft(trimmed)
    try {
      await writeRuntimeIssueCommand(hookRuntimeSettings, repoId, trimmed, selectedHostId, kind)
      lastCommittedIssueCommandRef.current = trimmed
      setIssueCommandSaveError(null)
    } catch (error) {
      console.error(`[RepositoryHooksSection] Failed to write ${kind} command:`, error)
      const message = error instanceof Error ? error.message : `Failed to save ${kind} command.`
      setIssueCommandSaveError(message)
      toast.error(message)
    }
  }, [
    hookRuntimeSettings,
    issueCommandDraft,
    kind,
    repoId,
    selectedHostId,
    updateIssueCommandDraft
  ])

  return {
    issueCommandDraft,
    setIssueCommandDraft: updateIssueCommandDraft,
    hasSharedIssueCommand,
    issueCommandSaveError,
    commitIssueCommand
  }
}
