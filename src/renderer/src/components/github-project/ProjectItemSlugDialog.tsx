// Why: when a Project row's `content.repository` does not match any
// registered Orca repo, the main `GitHubItemDialog` cannot be used in
// repo-backed mode — it requires a `repoPath` for label/assignee pickers
// and conversation details. Per design doc §Dialog editing from Project
// rows, the dialog for unknown-repo rows is allowed to be a simplified
// surface (conversation + title/body/labels/assignees/comments) with
// Files, Checks, and review-thread tabs hidden. This component is that
// simplified surface; it also routes every write through slug-addressed
// mutation helpers and patches the Project table cache on success.
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import React from 'react'
import * as VisuallyHidden from 'radix-ui/visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import type { GitHubItemDialogProjectOrigin } from '@/components/GitHubItemDialog'
import { SlugDialogBody } from './slug-dialog/SlugDialogBody'
import { translate } from '@/i18n/i18n'

type Props = {
  projectOrigin: GitHubItemDialogProjectOrigin | null
  sourceTarget: RuntimeClientTarget
  onClose: () => void
}

export default function ProjectItemSlugDialog({
  projectOrigin,
  sourceTarget,
  onClose
}: Props): React.JSX.Element {
  const open = projectOrigin !== null

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px] lg:max-w-[860px]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {translate(
              'auto.components.github.project.ProjectItemSlugDialog.4450efea9c',
              'GitHub item'
            )}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.github.project.ProjectItemSlugDialog.e55a5c4e68',
              'Project row preview.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>
        {projectOrigin ? (
          <SlugDialogBody
            projectOrigin={projectOrigin}
            sourceTarget={sourceTarget}
            onClose={onClose}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
