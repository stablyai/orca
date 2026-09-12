import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

type MissingRepo = { owner: string; repo: string; url: string | null }

export function ProjectMissingRepoDialog({
  missingRepo,
  onClose,
  onAddRepo
}: {
  missingRepo: MissingRepo | null
  onClose: () => void
  onAddRepo: () => void | Promise<unknown>
}): React.JSX.Element {
  return (
    <Dialog open={missingRepo !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.github.project.ProjectViewWrapper.7037c8f5f1',
              'Repository not in Orca'
            )}
          </DialogTitle>
          <DialogDescription>
            {missingRepo
              ? translate(
                  'auto.components.github.project.ProjectViewWrapper.1850fceac8',
                  "{{value0}}/{{value1}} isn't added to Orca. Add it to start work, or open in GitHub.",
                  { value0: missingRepo.owner, value1: missingRepo.repo }
                )
              : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="ghost" onClick={onClose}>
            {translate('auto.components.github.project.ProjectViewWrapper.dffa899f36', 'Cancel')}
          </Button>
          {missingRepo?.url ? (
            <Button
              variant="outline"
              onClick={() => {
                void window.api.shell.openUrl(missingRepo.url!)
                onClose()
              }}
            >
              {translate(
                'auto.components.github.project.ProjectViewWrapper.23b87ba9f7',
                'Open in GitHub'
              )}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              onClose()
              void onAddRepo()
            }}
          >
            {translate('auto.components.github.project.ProjectViewWrapper.840c268665', 'Add repo')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
