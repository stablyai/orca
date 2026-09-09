import { describe, expect, it } from 'vitest'
import {
  buildOrchestrationWorkerTerminalTitle,
  isOrchestrationWorkerTerminalTitle
} from './orchestration-worker-terminal-title'

describe('orchestration worker terminal title', () => {
  it('recognises every title it builds', () => {
    for (const taskId of ['task_f6116b98166e', 'task_remote-1', 'task_ABC_123']) {
      expect(
        isOrchestrationWorkerTerminalTitle(buildOrchestrationWorkerTerminalTitle(taskId))
      ).toBe(true)
    }
  })

  it('does not claim titles that merely start the same way', () => {
    for (const title of [
      'worker-pool sizing',
      'worker-task_ retry policy',
      'worker-task_',
      'worker-run_f6116b98166e',
      'the worker-task_f6116b98166e pane'
    ]) {
      expect(isOrchestrationWorkerTerminalTitle(title)).toBe(false)
    }
  })
})
