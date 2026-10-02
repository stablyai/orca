import { describe, expect, it } from 'vitest'
import { isOrchestrationWorkerTerminalTitle } from './orchestration-worker-terminal-title'

describe('isOrchestrationWorkerTerminalTitle', () => {
  it.each(['worker-task_0123abcdef45', 'worker-task_remote-1'])(
    'recognizes the reserved worker title %s',
    (title) => {
      expect(isOrchestrationWorkerTerminalTitle(title)).toBe(true)
    }
  )

  it.each(['worker-pool sizing', 'worker-run_0123abcdef45', 'debug worker-task_0123abcdef45'])(
    'keeps the ordinary title %s',
    (title) => {
      expect(isOrchestrationWorkerTerminalTitle(title)).toBe(false)
    }
  )
})
