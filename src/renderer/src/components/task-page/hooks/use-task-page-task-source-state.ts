import { useState } from 'react'

import { resolveVisibleTaskProvider, type TaskProvider } from '../../../../../shared/task-providers'

export function useTaskPageTaskSourceState({
  preferredTaskSource,
  visibleTaskProviders
}: {
  preferredTaskSource: TaskProvider
  visibleTaskProviders: TaskProvider[]
}) {
  const [taskSource, setTaskSource] = useState<TaskProvider>(
    resolveVisibleTaskProvider(preferredTaskSource, visibleTaskProviders)
  )

  return { taskSource, setTaskSource }
}
