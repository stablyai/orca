import { Pin, PinOff } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { usePersonalProjectOrderSupported } from '@/hooks/use-personal-project-order'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import { writePersonalProjectPreference } from '@/runtime/personal-project-order-client'
import { resolveProjectPreferenceKey } from '../../../../shared/project-preference-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'

export function ProjectPinMenuItem({ repo }: { repo: Repo }) {
  const supported = usePersonalProjectOrderSupported()
  const projectKey = useAppStore((state) =>
    resolveProjectPreferenceKey(
      repo.id,
      getProjectHostSetupProjectionFromState(state).setups,
      getRepoExecutionHostId(repo)
    )
  )
  const pinned = useAppStore((state) =>
    projectKey ? state.personalProjectOrder?.projects[projectKey]?.pinned === true : false
  )
  return (
    <DropdownMenuItem
      disabled={!supported || !projectKey}
      onSelect={() => {
        const state = useAppStore.getState()
        const projectKey = resolveProjectPreferenceKey(
          repo.id,
          getProjectHostSetupProjectionFromState(state).setups,
          getRepoExecutionHostId(repo)
        )
        if (projectKey) {
          void writePersonalProjectPreference('ui.setProjectPinned', {
            projectKey,
            pinned: !pinned
          }).catch(() =>
            toast.error(
              translate('sidebar.projectOrder.saveFailed', 'Could not save project order')
            )
          )
        }
      }}
    >
      {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      {pinned
        ? translate('sidebar.projectOrder.unpin', 'Unpin project')
        : translate('sidebar.projectOrder.pin', 'Pin project')}
    </DropdownMenuItem>
  )
}
