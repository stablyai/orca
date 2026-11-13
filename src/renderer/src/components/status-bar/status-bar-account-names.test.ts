import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  buildClaudeStatusSwitchGroups,
  resolveClaudeStatusAccountState
} from './status-bar-claude-accounts'
import {
  buildCodexStatusSwitchGroups,
  resolveCodexStatusAccountState
} from './status-bar-codex-accounts'

const HOST = { runtime: 'host' as const, wslDistro: null }
const saved = { createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }

// A rename changes only the names map, never the saved records the switchers also read.
function settingsWithNames(): GlobalSettings {
  return {
    ...getDefaultSettings('/tmp'),
    claudeManagedAccounts: [
      {
        id: 'claude-1',
        email: 'me@example.com',
        managedAuthPath: '',
        authMethod: 'subscription-oauth',
        ...saved
      }
    ],
    codexManagedAccounts: [
      { id: 'codex-1', email: 'me@example.com', managedHomePath: '', ...saved }
    ],
    managedAccountDisplayNames: { claude: { 'claude-1': 'Work' }, codex: { 'codex-1': 'Work' } }
  }
}

describe('status-bar account names', () => {
  it('shows a local Codex name from settings and keeps the email beside it', () => {
    const state = resolveCodexStatusAccountState(
      settingsWithNames(),
      { accounts: [], activeAccountId: null },
      null
    )
    const row = buildCodexStatusSwitchGroups(state, HOST)[0].targets[1]
    expect(row).toMatchObject({
      name: 'Work',
      detail: 'me@example.com',
      label: 'Work (me@example.com)'
    })
  })

  it('names a Claude row the host listed before the rename', () => {
    const hostRow = {
      id: 'claude-1',
      email: 'me@example.com',
      authMethod: 'subscription-oauth' as const,
      ...saved
    }
    const state = resolveClaudeStatusAccountState(
      settingsWithNames(),
      { accounts: [hostRow], activeAccountId: null },
      null
    )
    expect(buildClaudeStatusSwitchGroups(state, HOST)[0].targets[1].label).toBe(
      'Work (me@example.com)'
    )
  })
})
