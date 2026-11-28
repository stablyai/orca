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

it.each(['toggle', 'run', 'cancel'] as const)(
  'fences a held %s to its probed receiver, and permits the same-runtime control',
  async (action) => {
    const { updateAutomationForOwner, runAutomationNowForOwner, deleteAutomationForOwner } =
      await import('./automation-scoped-list-client')
    for (const replace of [true, false]) {
      let receiver = 'origin'
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const mutations: string[] = []
      vi.stubGlobal('window', {
        api: {
          runtimeEnvironments: {
            call: async (request: { method: string; expectedEnvironmentRuntimeId?: string }) => {
              if (request.method === 'status.get') {
                const response = createCompatibleRuntimeStatusResponse(receiver)
                entered()
                await held
                return {
                  ...response,
                  result: { ...response.result, capabilities: ['automation.owner-fencing.v1'] }
                }
              }
              if (request.expectedEnvironmentRuntimeId !== receiver) {
                throw new Error('Receiver changed before send')
              }
              mutations.push(request.method)
              return {
                ok: true,
                result: { automation: { id: 'a1', enabled: false }, run: { id: 'r1' } }
              }
            }
          }
        }
      })
      const sent =
        action === 'toggle'
          ? updateAutomationForOwner(owner, 'a1', { enabled: false })
          : action === 'run'
            ? runAutomationNowForOwner(owner, 'a1')
            : deleteAutomationForOwner(owner, 'a1')
      await ready
      if (replace) {
        receiver = 'replacement'
      }
      release()
      if (replace) {
        await expect(sent).rejects.toThrow('Receiver changed before send')
        expect(mutations).toEqual([])
      } else {
        await sent
        expect(mutations).toEqual([
          action === 'toggle'
            ? 'automation.update'
            : action === 'run'
              ? 'automation.runNow'
              : 'automation.delete'
        ])
      }
    }
  }
)
