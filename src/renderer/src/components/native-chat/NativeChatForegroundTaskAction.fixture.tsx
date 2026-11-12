import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatForegroundTasksProvider } from './NativeChatForegroundTaskAction'
import { NativeChatToolLine } from './tools/lines/NativeChatToolLine'

const task = {
  toolUseId: 'toolu_build',
  taskId: 'shell-31',
  turnId: 'turn-7',
  generation: 'process-4'
}

export const runningCommand = defineFixture({
  width: 390,
  render: () => (
    <NativeChatForegroundTasksProvider
      tasks={[task]}
      backgroundTask={async () => ({ backgrounded: true })}
    >
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          callId: 'toolu_build',
          name: 'Bash',
          input: {
            command:
              'pnpm test src/main/claude/structured/claude-structured-background-task.test.ts'
          },
          state: 'running'
        }}
      />
    </NativeChatForegroundTasksProvider>
  )
})
