import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Repo } from '../../../../../shared/repo-types'
import type { SettingsProjectRemovalScope } from '../navigation/settings-project-list'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

function getRemoveProjectDescription(
  scope: SettingsProjectRemovalScope,
  t: Translate = translate
): string {
  if (scope === 'checkout') {
    return t(
      'auto.components.settings.RepositoryPane.removeProjectCheckout',
      'Remove this checkout from Orca. Other checkouts of this project stay.'
    )
  }
  if (scope === 'split-project') {
    return t(
      'auto.components.settings.RepositoryPane.removeProjectKeepCheckouts',
      'Remove this project from Orca. Checkouts that have their own settings stay.'
    )
  }
  return t(
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
  const t = useTranslate()
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
      title={t('auto.components.settings.RepositoryPane.04eebebbea', 'Remove project')}
      description={getRemoveProjectDescription(removalScope, t)}
      keywords={[repo.displayName, 'delete', 'project', 'repository']}
      className="w-auto"
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
