import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { ORCA_CLOUD_NEEDS_REPO_ID } from './cloud-start-view'

/**
 * RR-c1 (Neil): Project's error after Create was pressed with Orca Cloud on a plain folder. Nothing
 * switches on its own; it says why Create stopped. With GitHub repositories to pick, the Project
 * dropdown is the way forward, so no link (Neil: "it's quite obvious"); with none, it offers to add one.
 */
export function OrcaCloudNeedsRepoLine({
  hasRepos,
  onAddRepository
}: {
  hasRepos: boolean
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
      {hasRepos ? null : (
        // statusAction pads its label by px-1; -mx-1 keeps the text flush with the line above.
        <div className="-mx-1">
          <Button type="button" variant="link" size="statusAction" onClick={onAddRepository}>
            {/* Reads as a link at rest, not only on hover (design-squad). */}
            <span className="underline underline-offset-4">
              {t('components.newWorkspace.cloudOnly.addRepository', 'Add a GitHub repository')}
            </span>
          </Button>
        </div>
      )}
    </div>
  )
}
