import { expect, it } from 'vitest'
import { structuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'

it('does not offer provider Stop for an orchestration-only roster', () => {
  const view = structuredSessionBackgroundTasksView(
    {
      state: 'monitoring',
      workerDock: { revision: 'epoch:1', open: true },
      children: [],
      supportsStopAll: true
    },
    null
  )
  expect(view.offersStopAll).toBe(false)
})

it('retains untargeted Stop for unlisted provider work during a turn', () => {
  const view = structuredSessionBackgroundTasksView(
    {
      state: 'monitoring',
      incomplete: true,
      children: [],
      supportsStopAll: true
    },
    'turn-1'
  )
  expect(view.offersStopAll).toBe(true)
})
