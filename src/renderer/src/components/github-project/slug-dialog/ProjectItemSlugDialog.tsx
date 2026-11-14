// For unregistered row repos, use slug-addressed edits and Project-cache updates without repo-backed Files, Checks or review threads.
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import React from 'react'
import * as VisuallyHidden from 'radix-ui/visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import type { GitHubItemDialogProjectOrigin } from '../../github-item-dialog/load-item-details/github-item-dialog-types'
import { SlugDialogBody } from './SlugDialogBody'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
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
            {t('auto.components.github.project.ProjectItemSlugDialog.4450efea9c', 'GitHub item')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {t(
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
