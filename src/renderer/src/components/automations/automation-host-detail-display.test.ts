import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { getAutomationHostDetailDisplay } from './automation-host-detail-display'

const RUNTIME_SELF: AutomationHostCatalogEntry = {
  stableRef: { authority: { kind: 'runtime', environmentId: 'r1' }, selector: { kind: 'self' } },
  owner: {
    authority: { kind: 'runtime', environmentId: 'r1', pairingRevision: 1 },
    selector: { kind: 'self' }
  },
  stableKey: 'host:runtime:r1:self',
  label: 'GPU box',
  authorityLabel: 'GPU box',
  kind: 'self',
  catalogState: 'authoritative',
  authorityHealth: 'fresh',
  executionHealth: 'connected',
  querySupport: 'scoped'
}

const DESKTOP_SSH: AutomationHostCatalogEntry = {
  ...RUNTIME_SELF,
  stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 't1' } },
  owner: {
    authority: { kind: 'desktop' },
    selector: { kind: 'ssh', targetId: 't1', targetGeneration: 1 }
  },
  stableKey: 'host:desktop:ssh:t1',
  label: 'openclaw',
  authorityLabel: 'Local Mac',
  kind: 'ssh'
}

function automation(overrides: Partial<Automation>): Automation {
  return { executionTargetType: 'local', executionTargetId: 'local', ...overrides } as Automation
}

describe('getAutomationHostDetailDisplay', () => {
  it('names the runtime that stores the record, not the “local” its target reads', () => {
    // The record's own target is local *to that server*; rendering it verbatim
    // would claim a remote automation runs on this Mac.
    const display = getAutomationHostDetailDisplay({
      automation: automation({ executionTargetType: 'local' }),
      entry: RUNTIME_SELF
    })

    expect(display).toEqual({ label: 'GPU box', title: 'GPU box' })
  })

  it('qualifies a host with the authority that stores it when the two differ', () => {
    const display = getAutomationHostDetailDisplay({
      automation: automation({ executionTargetType: 'ssh', executionTargetId: 't1' }),
      entry: DESKTOP_SSH
    })

    expect(display).toEqual({ label: 'openclaw', title: 'Local Mac · openclaw' })
  })

  it('falls back to the record’s own target for a row no host answered for', () => {
    const display = getAutomationHostDetailDisplay({
      automation: automation({ executionTargetType: 'ssh', executionTargetId: 't1' }),
      entry: null,
      hostLabelById: new Map([['ssh:t1', 'openclaw']])
    })

    expect(display).toEqual({ label: 'openclaw', title: 'openclaw' })
  })
})
