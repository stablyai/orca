import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { DEV_DRIVE_SETUP_URL } from '../../../../shared/perforce/workspace-copy/workspace-copy-platform'

/**
 * What Perforce copies need, shown wherever they are made or configured: Orca also runs where they
 * cannot be made at all. `unavailableHere` is for a workspace whose computer is one of those.
 */
export function PerforceCopyRequirement({
  unavailableHere = false,
  showSetupLink = true
}: {
  unavailableHere?: boolean
  showSetupLink?: boolean
}) {
  return (
    <div className="flex gap-1.5 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <p>
          {unavailableHere
            ? translate(
                'perforce.copies.unavailableHere',
                'Perforce copies need Windows 11 24H2 or later, with the workspace on a Dev Drive, so this workspace will share the project folder instead of getting its own copy.'
              )
            : translate(
                'perforce.copies.requirement',
                'Perforce copies need Windows 11 24H2 or later, with the workspace on a Dev Drive: each copy block-clones the workspace, so it takes almost no extra space. Elsewhere a new workspace shares the project folder.'
              )}
        </p>
        {showSetupLink ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="-ml-2"
            onClick={() => void window.api.shell.openUrl(DEV_DRIVE_SETUP_URL)}
          >
            {translate('perforce.copies.setUpDevDrive', 'Set up a Dev Drive')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
