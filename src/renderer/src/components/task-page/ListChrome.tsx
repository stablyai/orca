import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { cn } from '@/lib/class-names'
import { TaskPageGitHubListChrome } from './github/listing/Filters'
import { TaskPageProviderFilters } from './ProviderFilters'

type Props = { model: TaskPageComposerActionsModel }

export function TaskPageListChrome({ model }: Props): React.JSX.Element {
  return (
    <div className={cn('flex shrink-0 flex-col', model.taskPageListChromeHidden && 'hidden')}>
      {model.taskSource === 'github' ? (
        <TaskPageGitHubListChrome model={model} />
      ) : (
        <TaskPageProviderFilters model={model} />
      )}
    </div>
  )
}
