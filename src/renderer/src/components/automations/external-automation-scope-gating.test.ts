import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  ExternalAutomationScopeError
} from '../../../../shared/external-automation-scope'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import {
  externalAutomationProbeOwners,
  externalAutomationScopeGateFromError,
  parseExternalAutomationScopeCode
} from './external-automation-scope-gating'

function entry(overrides: Partial<AutomationHostCatalogEntry> = {}): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    stableKey: 'host:desktop:self',
    label: 'This computer',
    authorityLabel: 'This computer',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

const runtimeEntry = entry({
  stableRef: { authority: { kind: 'runtime', environmentId: 'env-1' }, selector: { kind: 'self' } },
  owner: {
    authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 1 },
    selector: { kind: 'self' }
  },
  stableKey: 'host:runtime:env-1:self',
  label: 'Build box',
  authorityLabel: 'Build box'
})

describe('external automation scope gating', () => {
  it('retains probe owners only for hosts that are actually listed', () => {
    expect(externalAutomationProbeOwners([entry(), runtimeEntry, entry({ owner: null })])).toEqual([
      { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
    ])
  })
})

describe('engine scope errors', () => {
  it('reads the code the engine appends to its message', () => {
    const hidden = new ExternalAutomationScopeError(EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden)
    expect(parseExternalAutomationScopeCode(hidden)).toBe(
      EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden
    )
    // Electron rewraps the message; the trailing token still terminates it.
    expect(
      parseExternalAutomationScopeCode(
        new Error(`Error invoking remote method 'x': ${hidden.message}`)
      )
    ).toBe(EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden)
  })

  it('leaves unrelated failures alone so they are not relabelled as scope limits', () => {
    expect(externalAutomationScopeGateFromError(new Error('socket hang up'))).toBeNull()
    expect(parseExternalAutomationScopeCode(null)).toBeNull()
  })
})
