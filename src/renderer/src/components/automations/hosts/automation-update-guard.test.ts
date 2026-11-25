import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationSaveContext } from '../authoring/automation-save-context'
import { saveExistingAutomation } from '../authoring/automation-orca-save-operations'
import { makeAutomation } from '../automations-page-fixtures'
import {
  updateAutomationForOwner,
  listAutomationRunsPageForOwner,
  readFullAutomationRun
} from './automation-scoped-list-client'
import { resetAutomationCapabilityProbes } from './automation-capability-probe'

const host = vi.hoisted(() => ({ status: vi.fn(), call: vi.fn() }))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  getRuntimeEnvironmentStatus: host.status
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: host.call }))

const authority = { kind: 'runtime', environmentId: 'env-1', pairingRevision: 7 } as const
const owner = { authority, selector: { kind: 'self' } } as const
const saved = makeAutomation({
  id: 'a1',
  name: 'Digest',
  rrule: 'FREQ=HOURLY',
  dtstart: 1,
  timezone: 'UTC',
  bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat' }
})

beforeEach(() => {
  vi.resetAllMocks()
  resetAutomationCapabilityProbes()
  host.call.mockResolvedValue({ automation: { ...saved, name: 'Renamed' } })
  host.status.mockResolvedValue({ capabilities: ['automation.owner-fencing.v1'] })
})

async function savePage() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Saving an existing record reads only the dispatch context from this page context.
  const context = {
    destination: {
      automationDispatchContext: {
        authority,
        capturedOwners: new Map([['row-a1', { owner, selector: { kind: 'self' } }]])
      }
    }
  } as unknown as AutomationSaveContext
  return await saveExistingAutomation(
    context,
    'a1',
    saved,
    { name: 'Renamed' },
    undefined,
    { kind: 'environment', environmentId: 'env-1' },
    'row-a1'
  )
}

describe('guarded automation updates', () => {
  it('refuses legacy history and exact-run acquisition before an old host can return every run', async () => {
    await expect(listAutomationRunsPageForOwner(owner, 'a1', { limit: 5 })).rejects.toMatchObject({
      code: 'unsupported_host_scope'
    })
    await expect(
      readFullAutomationRun(
        authority,
        { selector: { kind: 'self' } },
        { automationId: 'a1', id: 'r1' }
      )
    ).rejects.toMatchObject({ code: 'unsupported_host_scope' })
    expect(host.call).not.toHaveBeenCalled()
  })
  it('refuses a required panel edit on a host that would strip the guard', async () => {
    await expect(
      updateAutomationForOwner(owner, 'a1', { name: 'Renamed' }, undefined, {
        required: true,
        unchangedSince: { bot: saved.bot }
      })
    ).rejects.toMatchObject({ code: 'unsupported_host_scope' })
    expect(host.call).not.toHaveBeenCalled()
  })

  it('sends the page save snapshot to a capable host', async () => {
    host.status.mockResolvedValue({
      capabilities: ['automation.owner-fencing.v1', 'automation.update-guard.v1']
    })
    const result = await savePage()
    expect(result).toMatchObject({ ok: true, value: { id: 'a1', name: 'Renamed' } })
    expect(host.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.update',
      expect.objectContaining({
        unchangedSince: {
          bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat' },
          schedule: { rrule: 'FREQ=HOURLY', dtstart: 1, timezone: 'UTC' }
        }
      }),
      expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
    )
  })

  it('keeps the page save available without a guard on older hosts', async () => {
    const result = await savePage()
    expect(result).toMatchObject({ ok: true, value: { id: 'a1', name: 'Renamed' } })
    expect(host.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.update',
      {
        id: 'a1',
        updates: { name: 'Renamed' },
        expectedOwner: { selector: { kind: 'self' } },
        destination: undefined
      },
      expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
    )
  })
})
