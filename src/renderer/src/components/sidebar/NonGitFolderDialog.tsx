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
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { buildDismissedOnboardingFolderAgentStartup } from '@/lib/onboarding-folder-agent-startup'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { translate } from '@/i18n/i18n'

const NonGitFolderDialog = React.memo(function NonGitFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const addNonGitFolder = useAppStore((s) => s.addNonGitFolder)

  const isOpen = activeModal === 'confirm-non-git-folder'
  const folderPath = typeof modalData.folderPath === 'string' ? modalData.folderPath : ''
  const connectionId = typeof modalData.connectionId === 'string' ? modalData.connectionId : ''

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
          const repo = result.repo
          const state = useAppStore.getState()
          const hadProjectBeforeAdd = stateBeforeAdd.repos.length > 0
          if (!state.repos.some((r) => r.id === repo.id)) {
            useAppStore.setState({ repos: [...state.repos, repo] })
          }
          await markOnboardingProjectAdded('addedFolder')
          await state.fetchWorktrees(repo.id)
          // Why: mirror the local non-git folder flow — without this the
          // dialog closes and the UI shows no visible change, making the
          // add feel like a no-op. Activating the synthetic folder
          // worktree reveals it in the sidebar and opens the workspace.
          const folderWorktree = useAppStore.getState().worktreesByRepo[repo.id]?.[0]
          if (folderWorktree) {
            const onboarding = await window.api.onboarding.get().catch(() => null)
            // Why: SSH users can hit this dialog from Add Project after
            // dismissing onboarding, bypassing the local addNonGitFolder path.
            const startup = buildDismissedOnboardingFolderAgentStartup(
              useAppStore.getState().settings,
              onboarding,
              hadProjectBeforeAdd
            )
            activateAndRevealWorktree(folderWorktree.id, {
              sidebarRevealBehavior: 'auto',
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
      void addNonGitFolder(folderPath)
    }
    closeModal()
  }, [addNonGitFolder, closeModal, folderPath, connectionId])

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
