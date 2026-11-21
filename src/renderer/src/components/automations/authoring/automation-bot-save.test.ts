import { describe, expect, it } from 'vitest'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import { botHostUnavailableNotice } from './automation-bot-save'

function serverEntry(overrides: Partial<AutomationHostCatalogEntry>): AutomationHostCatalogEntry {
  return {
    stableRef: {
      authority: { kind: 'runtime', environmentId: 'env-1' },
      selector: { kind: 'self' }
    },
    owner: null,
    stableKey: 'runtime:env-1|self',
    label: 'Studio',
    authorityLabel: 'Studio',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

describe('botHostUnavailableNotice', () => {
  it('asks for a server update, not Retry, when the bot server is too old', () => {
    const notice = botHostUnavailableNotice(serverEntry({ querySupport: 'incompatible' }))
    expect(notice.recovery).toBe('update-server')
    expect(notice.message).toBe(
      'Update the Orca server on Studio so its bots can have automations.'
    )
  })

  it('asks for a server update when the server lists automations without host scoping', () => {
    const notice = botHostUnavailableNotice(
      serverEntry({ querySupport: 'legacy-unscoped', scopeGap: 'authority-unscoped' })
    )
    expect(notice.recovery).toBe('update-server')
  })

  it('keeps Retry while the bot host is not in the catalog yet', () => {
    expect(botHostUnavailableNotice(null).recovery).toBe('retry')
  })

  it('offers Reconnect when the bot server is unreachable', () => {
    expect(botHostUnavailableNotice(serverEntry({ authorityHealth: 'unavailable' })).recovery).toBe(
      'reconnect'
    )
  })
})
