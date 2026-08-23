import React, { useCallback, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { buildDismissedOnboardingFolderAgentStartup } from '@/lib/onboarding-folder-agent-startup'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { translate } from '@/i18n/i18n'
import { upsertAddedRepoWithProjectHostSetup } from './add-repo-store-upsert'
import { worktreeRefreshOptions } from './add-repo-runtime-owner'

const NonGitFolderDialog = React.memo(function NonGitFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const addNonGitFolder = useAppStore((s) => s.addNonGitFolder)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const convertNonGitFolderToGit = useAppStore((s) => s.convertNonGitFolderToGit)
  const [isConverting, setIsConverting] = useState(false)

  const isOpen = activeModal === 'confirm-non-git-folder'
  const folderPath = typeof modalData.folderPath === 'string' ? modalData.folderPath : ''
  const connectionId = typeof modalData.connectionId === 'string' ? modalData.connectionId : ''
  const runtimeEnvironmentId =
    typeof modalData.runtimeEnvironmentId === 'string' ? modalData.runtimeEnvironmentId : ''
  const runtimeEnvironmentName =
    runtimeEnvironmentId &&
    (runtimeEnvironments.find((environment) => environment.id === runtimeEnvironmentId)?.name ||
      runtimeEnvironmentId)
  const checkedHostDescription = connectionId
    ? translate(
        'auto.components.sidebar.NonGitFolderDialog.9a766f33ac',
        'This path was checked on the SSH host.'
      )
    : runtimeEnvironmentName
      ? translate(
          'auto.components.sidebar.NonGitFolderDialog.79fd02cf5f',
          'This path was checked on {{hostName}}.',
          { hostName: runtimeEnvironmentName }
        )
      : translate(
          'auto.components.sidebar.NonGitFolderDialog.8851b77327',
          'This path was checked locally.'
        )

  const handleConfirm = useCallback(() => {
    if (connectionId && folderPath) {
      void (async () => {
        try {
          const stateBeforeAdd = useAppStore.getState()
          const result = await window.api.repos.addRemote({
            connectionId,
            remotePath: folderPath,
            kind: 'folder'
          })
          if ('error' in result) {
            throw new Error(result.error)
          }
          const { repo } = upsertAddedRepoWithProjectHostSetup(result.repo, {
            sshConnectionId: connectionId
          })
          const state = useAppStore.getState()
          const hadProjectBeforeAdd = stateBeforeAdd.repos.length > 0
          await markOnboardingProjectAdded('addedFolder')
          const ownerOptions = worktreeRefreshOptions(undefined, connectionId)
          await state.fetchWorktrees(repo.id, ownerOptions)
          // Why: mirror the local non-git folder flow — without this the
          // dialog closes and the UI shows no visible change, making the
          // add feel like a no-op. Activating the synthetic folder
          // worktree reveals it in the sidebar and opens the workspace.
          const folderWorktree = useAppStore
            .getState()
            .worktreesByRepo[repo.id]?.find(
              (worktree) => worktree.hostId === ownerOptions.executionHostId
            )
          if (folderWorktree) {
            const onboarding = await window.api.onboarding.get().catch(() => null)
            // Why: SSH users can hit this dialog from Add Project after
            // dismissing onboarding, bypassing the local addNonGitFolder path.
            const startup = buildDismissedOnboardingFolderAgentStartup(
              useAppStore.getState().settings,
              onboarding,
              hadProjectBeforeAdd,
              isNativeChatTranscriptLocalReadable(connectionId)
            )
            activateAndRevealWorktree(folderWorktree.id, {
              sidebarRevealBehavior: 'auto',
              executionHostId: ownerOptions.executionHostId,
              ...(startup ? { startup } : {})
            })
          }
        } catch (err) {
          // This code path calls addRemote directly (not through the store),
          // so the store's toast handling does not apply.
          toast.error(
            err instanceof Error
              ? err.message
              : translate(
                  'auto.components.sidebar.NonGitFolderDialog.c49fb13492',
                  'Failed to add folder on this host'
                )
          )
        }
      })()
    } else if (folderPath) {
      void addNonGitFolder(folderPath, {
        runtimeEnvironmentId: runtimeEnvironmentId || null
      })
    }
    closeModal()
  }, [addNonGitFolder, closeModal, folderPath, connectionId, runtimeEnvironmentId])

  const handleConvert = useCallback(() => {
    if (!folderPath) {
      return
    }
    setIsConverting(true)
    void (async () => {
      try {
        const repo = await convertNonGitFolderToGit({
          path: folderPath,
          ...(connectionId ? { connectionId } : {}),
          runtimeEnvironmentId: runtimeEnvironmentId || null
        })
        if (repo) {
          const ownerOptions = worktreeRefreshOptions(runtimeEnvironmentId || null, connectionId)
          await useAppStore.getState().fetchWorktrees(repo.id, ownerOptions)
          const mainWorktree = useAppStore
            .getState()
            .worktreesByRepo[repo.id]?.find(
              (worktree) => worktree.hostId === ownerOptions.executionHostId
            )
          if (mainWorktree) {
            // Why: conversion should visibly replace the folder workflow without
            // requiring a remove/re-import cycle or a manual sidebar refresh.
            activateAndRevealWorktree(mainWorktree.id, {
              sidebarRevealBehavior: 'auto',
              executionHostId: ownerOptions.executionHostId
            })
          }
          closeModal()
        }
      } finally {
        setIsConverting(false)
      }
    })()
  }, [convertNonGitFolderToGit, closeModal, folderPath, connectionId, runtimeEnvironmentId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      // Don't let the dialog be dismissed mid-conversion — git is mutating the
      // folder and a half-closed UI would hide the outcome.
      if (!open && !isConverting) {
        closeModal()
      }
    },
    [closeModal, isConverting]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.sidebar.NonGitFolderDialog.15b3ae7310',
              "This folder isn't a Git repository"
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.NonGitFolderDialog.1d9e5c8007',
              'Convert it to a Git repository to use worktrees, source control, and code reviews. Or open it as a plain folder with just the editor, terminal, and search.'
            )}
            <span className="mt-2 block">{checkedHostDescription}</span>
          </DialogDescription>
        </DialogHeader>

        {folderPath && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all text-muted-foreground">{folderPath}</div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.sidebar.NonGitFolderDialog.2bef0e9e6d',
            "Converting runs git init, adds a .gitignore if one is missing, and makes an initial commit. Your existing files aren't changed."
          )}
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={handleConfirm} disabled={isConverting}>
            {translate('auto.components.sidebar.NonGitFolderDialog.e52454b7f6', 'Open as Folder')}
          </Button>
          <Button onClick={handleConvert} disabled={isConverting}>
            {isConverting && <Loader2 className="size-4 animate-spin" />}
            {translate(
              'auto.components.sidebar.NonGitFolderDialog.eb079b3809',
              'Convert to Git Repository'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default NonGitFolderDialog
