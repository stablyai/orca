import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { ORCA_CLOUD_NEEDS_REPO_ID } from './cloud-start-view'

/**
 * RR-c1 (Neil): Project's error after Create was pressed with Orca Cloud on a plain folder. Nothing
 * switches on its own; it says why Create stopped and offers the one way forward: choose a GitHub
 * repository (the Project picker opens at them), or add one when there are none.
 */
export function OrcaCloudNeedsRepoLine({
  hasRepos,
  onChooseRepository,
  onAddRepository
}: {
  hasRepos: boolean
  onChooseRepository: () => void
  onAddRepository: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      id={ORCA_CLOUD_NEEDS_REPO_ID}
      role="alert"
      className="flex flex-col items-start text-[11px]"
      data-orca-cloud-needs-repo
    >
      <p className="text-destructive">
        {t(
          'components.newWorkspace.cloudOnly.needsRepository',
          'Orca Cloud needs a GitHub repository.'
        )}
      </p>
      {/* statusAction pads its label by px-1; -mx-1 keeps the text flush with the line above. */}
      <div className="-mx-1">
        <Button
          type="button"
          variant="link"
          size="statusAction"
          onClick={hasRepos ? onChooseRepository : onAddRepository}
        >
          {/* Reads as a link at rest, not only on hover (design-squad). */}
          <span className="underline underline-offset-4">
            {hasRepos
              ? t('components.newWorkspace.cloudOnly.chooseRepository', 'Choose repository')
              : t('components.newWorkspace.cloudOnly.addRepository', 'Add a GitHub repository')}
          </span>
        </Button>
      </div>
    </div>
  )
}
