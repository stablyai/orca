import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  ExternalAutomationScopeError
} from '../../../../shared/external-automation-scope'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import {
  externalAutomationProbeOwners,
  externalAutomationScopeGateFromError,
  parseExternalAutomationScopeCode,
  resolveExternalAutomationScopeGate
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
  it('lists managers only for a desktop host with a captured owner', () => {
    const gate = resolveExternalAutomationScopeGate(entry())
    expect(gate.status).toBe('listed')
    expect(gate.probeOwner).toEqual({
      authority: { kind: 'desktop' },
      selector: { kind: 'self' }
    })
  })

  it('never presents a runtime-owned host as clean', () => {
    const gate = resolveExternalAutomationScopeGate(runtimeEntry)
    expect(gate.status).toBe('not-listed')
    expect(gate.code).toBe(EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported)
    expect(gate.probeOwner).toBeNull()
  })

  it('fails closed when no owner was captured, so nothing is probed', () => {
    const gate = resolveExternalAutomationScopeGate(entry({ owner: null }))
    expect(gate.status).toBe('not-listed')
    expect(gate.probeOwner).toBeNull()
  })

  it('treats the orphan bucket as scope limited rather than empty', () => {
    const orphan = entry({
      stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'orphan' } },
      kind: 'orphan',
      owner: null,
      stableKey: 'host:desktop:orphan'
    })
    expect(resolveExternalAutomationScopeGate(orphan).status).toBe('not-listed')
  })

  it('makes no claim for an unresolved host', () => {
    const gate = resolveExternalAutomationScopeGate(null)
    expect(gate.status).toBe('unknown')
    expect(gate.probeOwner).toBeNull()
    // Why: 'unknown' is not a limitation, so it must not print the scope note.
  })

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

  it('turns a hidden-target rejection into its own copy, not the generic note', () => {
    const gate = externalAutomationScopeGateFromError(
      new ExternalAutomationScopeError(EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden)
    )
    expect(gate?.status).toBe('not-listed')
  })

  it('leaves unrelated failures alone so they are not relabelled as scope limits', () => {
    expect(externalAutomationScopeGateFromError(new Error('socket hang up'))).toBeNull()
    expect(parseExternalAutomationScopeCode(null)).toBeNull()
  })
})
