import React from 'react'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { TaskPagePlaneSurface } from '@/components/task-page-plane-surface'

export function TaskPagePlaneContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const { hideTaskSource, handleUsePlaneItem } = model
  return (
    <TaskPagePlaneSurface
      onHide={() => hideTaskSource('plane', 'Plane')}
      onStartWorkspace={handleUsePlaneItem}
    />
  )
}
