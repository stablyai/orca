// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'

const mocks = vi.hoisted(() => ({ toast: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(mocks.toast, { success: mocks.success }) }))

import {
  followWslMoveOrchestratorStatus,
  useWslMoveOrchestratorStatus,
  wslMoveOrchestratorRecordFor
} from './wsl-move-orchestrator-status'
import { wslMoveOrchestratorLine } from './wsl-move-orchestrator-copy'

const PARKED: WslMoveOrchestratorRecord = {
  distro: 'Ubuntu',
  state: { kind: 'parked', reason: 'stuck' },
  attempts: 0,
  appVersion: '1.0.0',
  updatedAt: 1
}

describe('followWslMoveOrchestratorStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Main answers null until its orchestrator exists; its first publish then carries the sidecar.
  it('shows a persisted parked record from the first publish without a toast', async () => {
    let push: (list: WslMoveOrchestratorRecord[]) => void = () => {}
    vi.stubGlobal('api', {
      wslMove: {
        listOrchestrator: async () => null,
        onOrchestratorStatus: (listener: (list: WslMoveOrchestratorRecord[]) => void) => {
          push = listener
          return () => {}
        }
      }
    })
    const stop = followWslMoveOrchestratorStatus()
    await Promise.resolve()
    await Promise.resolve()

    push([PARKED])

    const record = wslMoveOrchestratorRecordFor(
      useWslMoveOrchestratorStatus.getState().records,
      'Ubuntu'
    )
    expect(wslMoveOrchestratorLine(record)?.kind).toBe('stuck')
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
    stop()
  })
})
