// The setup panel's way forward for a plain folder on Orca Cloud (design-squad: D3 for folders):
// choose a GitHub repository from the Project picker (D4), or add a GitHub project.
import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function FolderGitHubActions({
  canChoose,
  onChooseRepository,
  onAddProject
}: {
  /** Signed in with GitHub access: the Project picker lists repositories to choose from. */
  canChoose: boolean
  onChooseRepository: () => void
  onAddProject: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-3">
      {canChoose ? (
        <Button type="button" variant="link" size="statusAction" onClick={onChooseRepository}>
          {t('components.newWorkspace.cloudOnly.chooseRepository', 'Choose a GitHub repository')}
        </Button>
      ) : null}
      <Button type="button" variant="link" size="statusAction" onClick={onAddProject}>
        {t('components.newWorkspace.cloudOnly.addGitHubProject', 'Add a GitHub project…')}
      </Button>
    </span>
  )
}
