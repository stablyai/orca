import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'

export function ProjectRenameDialog({
  repo,
  onOpenChange
}: {
  repo: Repo | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const updateRepo = useAppStore((s) => s.updateRepo)
  return (
    <ProjectGroupNameDialog
      open={repo !== null}
      title={t('auto.components.sidebar.WorktreeList.renameProject', 'Rename project')}
      description={t(
        'auto.components.sidebar.WorktreeList.renameProjectDescription',
        'Choose the name shown for this project in the sidebar and tabs.'
      )}
      fieldLabel={t('auto.components.sidebar.WorktreeList.projectNameLabel', 'Project name')}
      initialName={repo?.displayName ?? ''}
      confirmLabel={t('auto.components.sidebar.WorktreeList.saveProjectName', 'Save')}
      onOpenChange={onOpenChange}
      onSubmit={async (name) => {
        if (!repo) {
          return
        }
        const updated = await updateRepo(
          repo.id,
          { displayName: name },
          {
            hostId: getRepoExecutionHostId(repo)
          }
        )
        if (!updated) {
          toast.error(
            t(
              'auto.components.sidebar.WorktreeList.renameProjectFailed',
              'Could not rename the project'
            )
          )
          throw new Error('Failed to rename project')
        }
      }}
    />
  )
}
