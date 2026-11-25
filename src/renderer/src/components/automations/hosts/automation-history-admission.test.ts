import { afterEach, expect, it, vi } from 'vitest'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import {
  listAutomationRunsPageForOwner,
  readFullAutomationRun
} from './automation-scoped-list-client'

vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  ensureRuntimeEnvironmentCompatible: async () => null
}))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: (_id: string, expected: number) => expected
}))

const owner = {
  authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 7 },
  selector: { kind: 'self' }
} as const

afterEach(() => vi.unstubAllGlobals())

it('requires an update for both pre-flag bounded hosts and truly unbounded hosts without acquiring history', async () => {
  for (const oldCapabilities of [['automation.owner-fencing.v1'], []]) {
    let historyAcquired = false
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: async (request: { method: string }) => {
            if (request.method === 'status.get') {
              const response = createCompatibleRuntimeStatusResponse('old-runtime')
              return { ...response, result: { ...response.result, capabilities: oldCapabilities } }
            }
            historyAcquired = true
            return { ok: true, result: { runs: [] } }
          }
        }
      }
    })
    await expect(listAutomationRunsPageForOwner(owner, 'a1', { limit: 5 })).rejects.toThrow(
      'panel or Automations page'
    )
    await expect(
      readFullAutomationRun(
        owner.authority,
        { selector: { kind: 'self' } },
        { automationId: 'a1', id: 'r1' }
      )
    ).rejects.toThrow('panel or Automations page')
    expect(historyAcquired).toBe(false)
  }
})

it('binds the admitted history read to the probed receiver even when the pairing revision stays the same', async () => {
  let receiver = 'capable-runtime'
  let historyAcquired = false
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: async (request: { method: string; expectedEnvironmentRuntimeId?: string }) => {
          if (request.method === 'status.get') {
            const response = createCompatibleRuntimeStatusResponse(receiver)
            receiver = 'replacement-runtime'
            return {
              ...response,
              result: { ...response.result, capabilities: ['automation.bounded-history.v1'] }
            }
          }
          if (request.expectedEnvironmentRuntimeId !== receiver) {
            throw new Error('Receiver changed before send')
          }
          historyAcquired = true
          return { ok: true, result: { runs: [] } }
        }
      }
    }
  })
  await expect(listAutomationRunsPageForOwner(owner, 'a1', { limit: 5 })).rejects.toThrow(
    'Receiver changed before send'
  )
  expect(historyAcquired).toBe(false)
})
