import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageListChrome } from './ListChrome'
import { TaskPageContent } from './Content'
import { RailPage, RailPageBody } from '@/components/rail-page/RailPage'
export function TaskPageFrame({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  return (
    <RailPage>
      <TaskPageListChrome model={model} />
      <RailPageBody>
        <TaskPageContent model={model} />
      </RailPageBody>
    </RailPage>
  )
}
