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
  onAddRepository,
  unreachable = false,
  onMoreAccess
}: {
  hasRepos: boolean
  onAddRepository: () => void
  /** UNREACHABLE-REPO-NO-ROUTE: the project's own GitHub repository is out of Orca Cloud's reach. */
  unreachable?: boolean
  /** Opens GitHub to give Orca access to more repositories ("Give Orca access"). */
  onMoreAccess?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (unreachable) {
    return (
      <div
        id={ORCA_CLOUD_NEEDS_REPO_ID}
        role="alert"
        className="flex flex-col items-start text-[11px]"
        data-orca-cloud-needs-repo="unreachable"
      >
        <p className="text-muted-foreground">
          {t(
            'components.newWorkspace.cloudOnly.remoteServerUnreachable',
            'Orca Cloud starts from a GitHub repository and can’t reach this project’s. Give Orca access to it, or pick another repository.'
          )}
        </p>
        {onMoreAccess ? (
          <div className="-mx-1">
            <Button type="button" variant="link" size="statusAction" onClick={onMoreAccess}>
              <span className="underline underline-offset-4">
                {t('worktreeCreation.cloneAccess.giveAccess', 'Give Orca access')}
              </span>
            </Button>
          </div>
        ) : null}
      </div>
    )
  }
  return (
    <div
      id={ORCA_CLOUD_NEEDS_REPO_ID}
      role="alert"
      className="flex flex-col items-start text-[11px]"
      data-orca-cloud-needs-repo
    >
      <p className="text-muted-foreground">
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
