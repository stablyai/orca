import { afterEach, describe, expect, it } from 'vitest'
import {
  enqueueAgentProcessInspection,
  resetAgentProcessInspectionQueueForTests
} from './agent-process-inspection-queue'

// Node emits 'unhandledRejection' a turn after the microtask queue drains.
async function settleRejections(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function collectUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = []
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandledRejection)
  try {
    await run()
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
  }
  return unhandled
}

describe('agent process inspection queue rejection containment', () => {
  afterEach(() => {
    resetAgentProcessInspectionQueueForTests()
  })

  it('contains an unreachable-runtime inspection failure instead of raising unhandledrejection', async () => {
    const unhandled = await collectUnhandledRejections(async () => {
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        run: () =>
          Promise.reject(
            new Error(
              "Error invoking remote method 'runtimeEnvironments:call': RemoteRuntimeClientError: Could not connect to the remote Orca runtime."
            )
          )
      })
      await settleRejections()
    })

    expect(unhandled).toEqual([])
  })

  it('keeps draining the queue after a rejecting inspection', async () => {
    const ran: string[] = []
    const unhandled = await collectUnhandledRejections(async () => {
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        run: () => Promise.reject(new Error('unreachable'))
      })
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        run: async () => {
          ran.push('second')
        }
      })
      await settleRejections()
    })

    expect(unhandled).toEqual([])
    expect(ran).toEqual(['second'])
  })
})
