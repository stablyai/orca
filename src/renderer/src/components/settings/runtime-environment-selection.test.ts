import { expect, it } from 'vitest'
import {
  createEnvironmentFromPairingOffer,
  redactRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { RuntimeEnvironmentReconciliationRecord } from '../../../../shared/runtime-environment-reconciliation-record'
import {
  LOCAL_RUNTIME_VALUE,
  runtimeEnvironmentSelectionOptions
} from './runtime-environment-selection'

function registrations(stage: RuntimeEnvironmentReconciliationRecord['stage'] = 'catalog-active') {
  const reconciliation: RuntimeEnvironmentReconciliationRecord = {
    version: 1,
    stage,
    requestId: 'request',
    canonicalEnvironmentId: 'canonical',
    runtimeId: 'host',
    preparedAt: 1,
    registrations: ['canonical', 'historical'].map((environmentId) => ({
      environmentId,
      authorityDigest: 'a'.repeat(64)
    }))
  }
  return ['canonical', 'historical'].map((id) => ({
    ...redactRuntimeEnvironment(
      createEnvironmentFromPairingOffer({
        id,
        name: `Host ${id}`,
        now: 1,
        offer: {
          v: 2,
          endpoint: `wss://${id}.example`,
          publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
          deviceToken: `grant-${id}`
        }
      })
    ),
    reconciliation
  }))
}

it.each([LOCAL_RUNTIME_VALUE, 'canonical', 'missing'])(
  'offers the canonical registration without changing the full registry when active is %s',
  (active) => {
    const rows = registrations()
    const original = structuredClone(rows)
    const options = runtimeEnvironmentSelectionOptions(rows, active)
    expect(options).toEqual([rows[0]])
    expect(options[0]).toBe(rows[0])
    expect(rows).toEqual(original)
  }
)

it('retains the selected historical grant without replacing its name or endpoint', () => {
  const rows = registrations()
  const options = runtimeEnvironmentSelectionOptions(rows, 'historical')
  expect(options).toEqual(rows)
  expect(options[1]).toBe(rows[1])
  expect(options[1].endpoints[0].endpoint).toBe('wss://historical.example')
  expect(runtimeEnvironmentSelectionOptions(rows, 'canonical')).toEqual([rows[0]])
  expect(rows).toHaveLength(2)
})

it('keeps prepared, canceled and incomplete catalogs selectable', () => {
  const prepared = registrations('prepared')
  expect(runtimeEnvironmentSelectionOptions(prepared, LOCAL_RUNTIME_VALUE)).toEqual(prepared)
  const canceled = registrations().map((row) => ({ ...row, reconciliation: undefined }))
  expect(runtimeEnvironmentSelectionOptions(canceled, LOCAL_RUNTIME_VALUE)).toEqual(canceled)
  const incomplete = [registrations()[1]]
  expect(runtimeEnvironmentSelectionOptions(incomplete, LOCAL_RUNTIME_VALUE)).toEqual(incomplete)
})
