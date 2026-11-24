import { expect, it } from 'vitest'
import { sayBackgroundTaskEnglish } from '../../../agent-status/presentation/background-tasks/background-task-copy'
import { nativeChatBackgroundTaskRun } from './native-chat-background-task-run'

it('presents a settled background task failure as failed', () => {
  const row = nativeChatBackgroundTaskRun(
    {
      type: 'background-task',
      taskId: 'task-1',
      kind: 'command',
      label: 'Build',
      state: 'blocked'
    },
    sayBackgroundTaskEnglish
  )

  expect(row.dotState).toBe('failed')
})
