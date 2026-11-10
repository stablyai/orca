import { describe, expect, it, vi } from 'vitest'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import {
  runAutomationHostRecovery,
  type AutomationHostRecoveryDeps
} from './automation-host-recovery'

function entry(
  overrides: Partial<AutomationHostCatalogEntry> & Pick<AutomationHostCatalogEntry, 'stableRef'>
): AutomationHostCatalogEntry {
  return {
    owner: null,
    stableKey: 'host',
    label: 'Host',
    authorityLabel: 'Authority',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

function deps() {
  return {
    retry: vi.fn<AutomationHostRecoveryDeps['retry']>(),
    connectSshTarget: vi.fn<AutomationHostRecoveryDeps['connectSshTarget']>(),
    connectRuntimeEnvironment: vi.fn<AutomationHostRecoveryDeps['connectRuntimeEnvironment']>(),
    openSettings: vi.fn<AutomationHostRecoveryDeps['openSettings']>()
  }
}

const RUNTIME_ENVIRONMENT_ID = 'gpu'
const RUNTIME_SSH = entry({
  stableRef: {
    authority: { kind: 'runtime', environmentId: RUNTIME_ENVIRONMENT_ID },
    selector: { kind: 'ssh', targetId: 't1' }
  },
  kind: 'ssh'
})

describe('automation host recovery', () => {
  it('dials the runtime first when the server itself is unreachable', () => {
    const target = deps()
    // Why: an unreachable server cannot be asked to dial its own SSH target.
    runAutomationHostRecovery(
      'reconnect',
      { ...RUNTIME_SSH, authorityHealth: 'unavailable' },
      target
    )
    expect(target.connectRuntimeEnvironment).toHaveBeenCalledWith(RUNTIME_ENVIRONMENT_ID)
    expect(target.connectSshTarget).not.toHaveBeenCalled()
  })
})
