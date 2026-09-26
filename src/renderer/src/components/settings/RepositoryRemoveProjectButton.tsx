import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Repo } from '../../../../shared/repo-types'
import type { SettingsProjectRemovalScope } from './settings-project-list'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

function getRemoveProjectDescription(scope: SettingsProjectRemovalScope): string {
  if (scope === 'checkout') {
    return translate(
      'auto.components.settings.RepositoryPane.removeProjectCheckout',
      'Remove this checkout from Orca. Other checkouts of this project stay.'
    )
  }
  if (scope === 'split-project') {
    return translate(
      'auto.components.settings.RepositoryPane.removeProjectKeepCheckouts',
      'Remove this project from Orca. Checkouts that have their own settings stay.'
    )
  }
  return translate(
    'auto.components.settings.RepositoryPane.removeProjectAllHosts',
    'Remove this project from Orca on all configured hosts.'
  )
}

export function RepositoryRemoveProjectButton({
  repo,
  removalScope,
  forceVisible,
  removeProject
}: {
  repo: Repo
  removalScope: SettingsProjectRemovalScope
  forceVisible: boolean
  removeProject: (repoId: string) => void
}) {
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const removeProjectLabel =
    confirmingRemove === repo.id ? 'Confirm Remove Project' : 'Remove Project'

  const handleRemoveProject = (repoId: string) => {
    if (confirmingRemove === repoId) {
      removeProject(repoId)
      setConfirmingRemove(null)
      return
    }

    setConfirmingRemove(repoId)
  }

  return (
    <SearchableSetting
      title={translate('auto.components.settings.RepositoryPane.0909e5d650', 'Remove Project')}
      description={getRemoveProjectDescription(removalScope)}
      keywords={[repo.displayName, 'delete', 'project', 'repository']}
      className="absolute top-0 right-0 z-10 w-auto max-w-none"
      forceVisible={forceVisible}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={confirmingRemove === repo.id ? 'destructive' : 'outline'}
            size="icon-sm"
            onClick={() => handleRemoveProject(repo.id)}
            onBlur={() => setConfirmingRemove(null)}
            aria-label={removeProjectLabel}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {removeProjectLabel}
        </TooltipContent>
      </Tooltip>
    </SearchableSetting>
  )
}
