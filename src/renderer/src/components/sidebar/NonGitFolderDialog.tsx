import React, { useCallback } from 'react'
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
import {
  resolveDismissedOnboardingFolderAgentLaunch,
  revealOnboardingFolderWithAgentLaunch
} from '@/lib/onboarding-folder-agent-launch'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { translate } from '@/i18n/i18n'
import { upsertAddedRepoWithProjectHostSetup } from './add-repo-store-upsert'
import { worktreeRefreshOptions } from './add-repo-runtime-owner'
import { addRuntimeSshRepo } from '@/runtime/runtime-ssh-target-management'
import type { Repo } from '../../../../shared/repo-types'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

// Why: the SSH target is a paired server's own host, and only that server adds a project on it.
async function addSshFolderProject(args: {
  connectionId: string
  runtimeEnvironmentId: string | null
  remotePath: string
  displayName: string
}): Promise<{
  repo: Repo
  ownerOptions: ReturnType<typeof worktreeRefreshOptions>
}> {
  if (!args.runtimeEnvironmentId) {
    throw new Error(`SSH connection "${args.connectionId}" not found or not connected`)
  }
  const added = await addRuntimeSshRepo(args.runtimeEnvironmentId, {
    connectionId: args.connectionId,
    remotePath: args.remotePath,
    kind: 'folder',
    ...(args.displayName ? { displayName: args.displayName } : {})
  })
  return {
    repo: upsertAddedRepoWithProjectHostSetup(added, {
      runtimeEnvironmentId: args.runtimeEnvironmentId
    }).repo,
    ownerOptions: worktreeRefreshOptions(args.runtimeEnvironmentId)
  }
}

const NonGitFolderDialog = React.memo(function NonGitFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const addNonGitFolder = useAppStore((s) => s.addNonGitFolder)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)

  const isOpen = activeModal === 'confirm-non-git-folder'
  const folderPath = typeof modalData.folderPath === 'string' ? modalData.folderPath : ''
  const connectionId = typeof modalData.connectionId === 'string' ? modalData.connectionId : ''
  const runtimeEnvironmentId =
    typeof modalData.runtimeEnvironmentId === 'string' ? modalData.runtimeEnvironmentId : ''
  const displayName = typeof modalData.displayName === 'string' ? modalData.displayName.trim() : ''
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
          const { repo, ownerOptions } = await addSshFolderProject({
            connectionId,
            runtimeEnvironmentId: runtimeEnvironmentId || null,
            remotePath: folderPath,
            displayName
          })
          const state = useAppStore.getState()
          const hadProjectBeforeAdd = stateBeforeAdd.repos.length > 0
          const onboardingBeforeAdd = await markOnboardingProjectAdded('addedFolder')
          await state.fetchWorktrees(repo.id, ownerOptions)
          // Why: mirror the local non-git folder flow — without this the
          // dialog closes and the UI shows no visible change, making the
          // add feel like a no-op. Activating the synthetic folder
          // worktree reveals it in the sidebar and opens the workspace.
          const folderWorktree = selectWorktreesByRepo(useAppStore.getState())[repo.id]?.find(
            (worktree) => worktree.hostId === ownerOptions.executionHostId
          )
          if (folderWorktree) {
            // Why: SSH users can hit this dialog from Add Project after
            // dismissing onboarding, bypassing the local addNonGitFolder path.
            const launch = resolveDismissedOnboardingFolderAgentLaunch({
              worktreeId: folderWorktree.id,
              store: useAppStore.getState(),
              onboarding: onboardingBeforeAdd,
              hasExistingProject: hadProjectBeforeAdd,
              executionHostId: ownerOptions.executionHostId ?? connectionId
            })
            await revealOnboardingFolderWithAgentLaunch({
              worktreeId: folderWorktree.id,
              executionHostId: ownerOptions.executionHostId,
              launch
            })
          }
        } catch (err) {
          // This code path calls the server directly (not through the store),
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
        runtimeEnvironmentId: runtimeEnvironmentId || null,
        ...(displayName ? { displayName } : {})
      })
    }
    closeModal()
  }, [addNonGitFolder, closeModal, displayName, folderPath, connectionId, runtimeEnvironmentId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.NonGitFolderDialog.e52454b7f6', 'Open as Folder')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.NonGitFolderDialog.8fba4b8cbb',
              "This folder isn't a Git repository. You'll have the editor, terminal, and search, but Git-based features won't be available."
            )}
            <span className="mt-2 block">{checkedHostDescription}</span>
          </DialogDescription>
        </DialogHeader>

        {folderPath && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all text-muted-foreground">{folderPath}</div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {translate('auto.components.sidebar.NonGitFolderDialog.05b33a17a9', 'Cancel')}
          </Button>
          <Button onClick={handleConfirm}>
            {translate('auto.components.sidebar.NonGitFolderDialog.e52454b7f6', 'Open as Folder')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default NonGitFolderDialog
