import { expect, it } from 'vitest'
import { getAgentRowConversationName } from './agent-row-conversation-name'
import type { WorkerTabStamp } from '../../orchestration/workers/worker-tab-stamp'

function worker(): WorkerTabStamp {
  return {
    origin: {
      runId: 'run',
      dispatchId: 'dispatch',
      taskId: 'task',
      taskTitle: 'Check release color',
      parent: { kind: 'pane', paneKey: 'coordinator' },
      coordinator: { kind: 'pane', paneKey: 'coordinator' }
    }
  }
}

it('names a stamped worker row by its task instead of the provider conversation', () => {
  expect(
    getAgentRowConversationName(
      {
        title: 'Ask coordinator',
        customTitle: null,
        aiVaultTitle: {
          agent: 'codex',
          sessionId: 'first',
          title: 'Ask coordinator',
          kind: 'named'
        },
        workerTab: worker()
      },
      'codex',
      true,
      'Provider pane title',
      'first'
    )
  ).toBe('Check release color')
})
