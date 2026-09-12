import { expect, it } from 'vitest'
import { projectRuntimeEnvironmentCatalog } from './runtime-environment-catalog-projection'
import type { RuntimeEnvironmentReconciliationRecord } from './runtime-environment-reconciliation-record'

function registrations() {
  const reconciliation: RuntimeEnvironmentReconciliationRecord = {
    version: 1,
    stage: 'catalog-active',
    requestId: 'request',
    canonicalEnvironmentId: 'canonical',
    runtimeId: 'host',
    preparedAt: 1,
    registrations: ['canonical', 'historical'].map((environmentId) => ({
      environmentId,
      authorityDigest: 'a'.repeat(64)
    }))
  }
  return ['canonical', 'historical'].map((id) => ({ id, reconciliation }))
}

it('projects complete groups without mutating the retained registry or canonical row', () => {
  const rows = registrations()
  const original = structuredClone(rows)
  const catalog = projectRuntimeEnvironmentCatalog(rows)
  expect(catalog).toEqual([{ environment: rows[0], historicalEnvironmentIds: ['historical'] }])
  expect(catalog[0].environment).toBe(rows[0])
  expect(rows).toEqual(original)
})

it.each(['missing', 'conflicting', 'duplicate', 'nonparticipant'])(
  'does not hide historical state for a %s catalog snapshot',
  (condition) => {
    let rows = registrations()
    if (condition === 'missing') {
      rows = [rows[1]]
    }
    if (condition === 'conflicting') {
      rows[0] = { ...rows[0], reconciliation: { ...rows[0].reconciliation, requestId: 'other' } }
    }
    if (condition === 'duplicate') {
      rows.push({ ...rows[0] })
    }
    if (condition === 'nonparticipant') {
      rows = [{ ...rows[1], id: 'unrelated' }]
    }
    expect(projectRuntimeEnvironmentCatalog(rows).map((entry) => entry.environment)).toEqual(rows)
  }
)
