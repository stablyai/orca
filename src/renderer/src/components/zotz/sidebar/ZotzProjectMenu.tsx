import React from 'react'
import { Ellipsis, EyeOff, Image, Settings, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { setProjectHidden } from '../../sidebar/hidden-projects/set-project-hidden'
import { getRepositoryIconSectionId } from '../../settings/repository/repository-settings-targets'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { Repo } from '../../../../../shared/repository/repo-types'

/** A project's "…" menu, with the same actions and dialogs as upstream's project header. */
export function ZotzProjectMenu({ repo }: { repo: Repo }): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openRepoSettings = (sectionId?: string): void => {
    openSettingsTarget({ pane: 'repo', repoId: repo.id, ...(sectionId ? { sectionId } : {}) })
    openSettingsPage()
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label={t(
            'auto.components.sidebar.WorktreeList.609633a9e6',
            'Project actions for {{value0}}',
            { value0: repo.displayName }
          )}
        >
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom">
        <DropdownMenuItem onSelect={() => openRepoSettings()}>
          <Settings className="size-4" />
          {t('auto.components.sidebar.WorktreeList.2cdffbc728', 'Project Settings')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openRepoSettings(getRepositoryIconSectionId(repo.id))}>
          <Image className="size-4" />
          {t('auto.components.sidebar.WorktreeList.e82d3589a1', 'Change Project Icon')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void setProjectHidden([repo], true, repo.displayName)}>
          <EyeOff className="size-4" />
          {t('sidebar.hiddenProjects.hideFromSidebar', 'Hide from Sidebar')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() =>
            openModal('confirm-remove-folder', {
              repoId: repo.id,
              displayName: repo.displayName,
              hostId: getRepoExecutionHostId(repo)
            })
          }
        >
          <Trash2 className="size-4" />
          {t('auto.components.sidebar.WorktreeList.c83968f87f', 'Remove Project')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
